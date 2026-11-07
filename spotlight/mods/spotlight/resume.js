// Continuar and auto-resume (T11, S10, S13; D13, D15), as pure functions the
// CLI (cli-resume.mjs) and the board (board.js) share: no fs, no clock, no
// herdr or gpui-kit import, so `node --test` loads it.
//
// The claude-accounts plugin's contract (its CONTRACT.md, salp-7b):
//   accounts.v1.json   { version: 1, active, accounts: [{ id, label, email,
//                      needsSignIn, error, usage: { session, weekly, fable,
//                      monthly } each { percent, resetsAt } | null, … }] }
//   resume --terminal <t> --account <id> --message <text> --json → { job }
//   resume --status <job> --json → { job, terminal, account, state, code,
//                      detail, updatedAt }; an unknown (or forgotten) job exits 7
// Continuar on a paused agent picks the account with the most limit left
// (Orca's pickResumeAccount, O/src/main/spotlight/spotlight-resume-account.ts)
// and has the plugin restart its Claude there with "Continue where you left
// off."; on an idle holder it sends Esc and the message in the same account
// (O/src/renderer/src/lib/test-queue-continue.ts:171-221); without the
// plugin it types the message into the same agent.
//
// A request carries Continuar's bookkeeping in state.json (queue.js copies
// fields it doesn't own through):
//   resumingUntil  the resume window's end (D13): inside it, turn ends, a new
//                  foreground and a gone terminal are not acted on
//   handledTurn    the turn count already spent
//   resumeJob      { id, account, label, auto, startedAt, state, code, detail,
//                  updatedAt, final } once the plugin accepted a job; the final
//                  state is cached the first time it is seen (D15, Job lifetime)
//   resumeError    { code, state?, text, at }: why the last Continuar didn't land
//   goneInWindow   the terminal went away while the window was open
//   autoResumes    delivered automatic resumes in a row (at most 3)
//   autoTriedPause the pause (its pausedAt) auto-resume already tried
//   autoRetryAt    when to try it again: 60 s after the first account's reset

import { inResumeWindow } from "./cli-turns.mjs";

// Orca's NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE.
export const CONTINUE_MESSAGE = "Continue where you left off.";
// Orca's RESUME_WINDOW_MS: extended while the plugin's job lives (D13).
export const RESUME_WINDOW_MS = 3 * 60_000;
// Orca's MAX_AUTO_RESUMES_IN_A_ROW.
export const MAX_AUTO_RESUMES = 3;
// Orca's RETRY_AFTER_RESET_MS: usage lags a reset by a moment.
export const RETRY_AFTER_RESET_MS = 60_000;
// The idle holder's Esc: the gap before the message, and how long the
// running turn gets to stop (Orca's ESC_PASTE_GAP_MS, ESC_SETTLE_MS).
export const ESC_PASTE_GAP_MS = 500;
export const ESC_SETTLE_MS = 5_000;

const FULL = 100;
const WINDOWS = ["session", "weekly", "fable", "monthly"];

// The job states of the contract: the live ones, and the final ones with
// their exit codes.
export const LIVE_JOB_STATES = ["queued", "waitingIdle", "stopping", "starting", "sending"];
export const FINAL_JOB_CODES = { done: 0, timeout: 4, landedElsewhere: 6, failed: 9, cancelled: 10 };

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v !== "";
const toMs = (v) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN);

// ── accounts.v1.json ───────────────────────────────────────────────────────

/**
 * accounts.v1.json's text (or its parsed value) → { ok: true, doc } or
 * { ok: false, reason: "missing" | "invalid" | "version", version? }. Any
 * version but 1 is refused (added fields keep version 1; Spotlight ignores
 * what it doesn't know). Accounts without an id are dropped.
 */
export function parseAccounts(input) {
  if (input == null) return { ok: false, reason: "missing" };
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, reason: "invalid" };
    }
  }
  if (!isObject(value)) return { ok: false, reason: "invalid" };
  if (value.version !== 1) return { ok: false, reason: "version", version: value.version ?? null };
  const accounts = (Array.isArray(value.accounts) ? value.accounts : []).filter((a) => isObject(a) && isText(a.id));
  return { ok: true, doc: { ...value, accounts } };
}

// An account's known usage windows ({ percent, resetsAt }).
function windowsOf(account) {
  const usage = isObject(account.usage) ? account.usage : {};
  return WINDOWS.map((k) => usage[k]).filter((w) => isObject(w) && typeof w.percent === "number" && Number.isFinite(w.percent));
}

/** The fullest of an account's windows (session, weekly, fable, monthly); null when none is known. */
export function peakOf(account) {
  const known = windowsOf(account).map((w) => w.percent);
  return known.length > 0 ? Math.max(...known) : null;
}

/** When an account at its limit gets it back: the latest reset among its full windows; null when none says. */
export function returnsAtOf(account) {
  const resets = windowsOf(account)
    .filter((w) => w.percent >= FULL)
    .map((w) => toMs(w.resetsAt))
    .filter(Number.isFinite);
  return resets.length > 0 ? Math.max(...resets) : null;
}

// Accounts that need a sign-in or whose last read failed never win (D15).
const canResumeOn = (account) => account.needsSignIn !== true && (account.error === null || account.error === undefined);

export const accountLabel = (account) => (isText(account?.label) ? account.label : isText(account?.email) ? account.email : account?.id ?? "");

/**
 * The account Continuar resumes with (D15): the lowest peak under 100%, the
 * active account winning ties; accounts that need a sign-in, carry an error
 * or have no known usage are skipped. → { kind: "account", id, label, peak },
 * or { kind: "none", returnsAt }: every candidate is full, and returnsAt is
 * the minimum over them of the maximum reset of their full windows (null
 * when none says).
 */
export function pickAccount(doc) {
  const accounts = Array.isArray(doc?.accounts) ? doc.accounts : [];
  const active = accounts.find((a) => a.id === doc?.active);
  const ordered = active ? [active, ...accounts.filter((a) => a !== active)] : accounts;
  let best = null;
  let returnsAt = null;
  for (const account of ordered) {
    if (!canResumeOn(account)) continue;
    const peak = peakOf(account);
    if (peak === null) continue;
    if (peak < FULL) {
      if (!best || peak < best.peak) best = { account, peak };
      continue;
    }
    const back = returnsAtOf(account);
    if (back !== null && (returnsAt === null || back < returnsAt)) returnsAt = back;
  }
  if (best) return { kind: "account", id: best.account.id, label: accountLabel(best.account), peak: best.peak };
  return { kind: "none", returnsAt };
}

/** The board's pick from accounts.v1.json's text: null when the file can't be used (missing, invalid, another version). */
export function pickFromText(text) {
  const parsed = parseAccounts(text);
  return parsed.ok ? pickAccount(parsed.doc) : null;
}

/** "Vuelve a las 9:05": the local time an account gets its limit back (Orca's backAt, hour and minute). */
export function formatReturn(ms) {
  const d = new Date(ms);
  return `Vuelve a las ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── Why a Continuar didn't land ────────────────────────────────────────────

// The plugin's immediate refusals of `resume` (exit codes), Spotlight's own
// refusals, and the final job states that leave the agent paused: the board
// shows `es`, the CLI prints `en`.
const REFUSALS = {
  2: { en: "this terminal has no Claude session to resume", es: "Sin sesión de Claude que retomar en esta terminal" },
  3: { en: "this terminal is not running Claude", es: "La terminal no corre Claude" },
  5: { en: "the account needs a sign-in", es: "La cuenta necesita iniciar sesión" },
  7: { en: "the claude-accounts plugin doesn't know that account", es: "Cuenta desconocida para el plugin de cuentas" },
  8: {
    en: "Claude is this terminal's own program: open Claude from a shell to be able to switch accounts",
    es: "Claude es el programa de la terminal: abre Claude desde una shell para poder cambiar de cuenta",
  },
  64: { en: "the claude-accounts plugin refused the call (bad usage)", es: "El plugin de cuentas rechazó la llamada (uso inválido)" },
  "no-account": { en: "no account has limit left", es: "Ninguna cuenta tiene límite ahora" },
  "accounts-version": {
    en: "accounts.v1.json has a version Spotlight doesn't read",
    es: "accounts.v1.json tiene una versión que Spotlight no lee",
  },
  "accounts-unreadable": { en: "accounts.v1.json can't be read", es: "No se pudo leer accounts.v1.json" },
  "send-failed": { en: "the message could not be typed into the terminal", es: "No se pudo escribir en la terminal" },
  unavailable: { en: "the claude-accounts plugin could not be run", es: "No se pudo ejecutar el plugin de cuentas" },
  signin: {
    en: "the agent needs a sign-in: sign in from the Claude accounts plugin (Inicia sesión), not an account switch",
    es: "Necesita iniciar sesión",
  },
  timeout: { en: "Claude didn't come back in time after the switch", es: "Claude no volvió a tiempo tras el cambio de cuenta" },
  landedElsewhere: { en: "the new Claude runs on another account", es: "Claude quedó en otra cuenta" },
  failed: { en: "the resume failed", es: "No se pudo retomar" },
  cancelled: { en: "the resume was cancelled", es: "Se canceló la reanudación" },
  unknown: { en: "the claude-accounts plugin no longer knows the job", es: "El plugin de cuentas ya no conoce la reanudación" },
  lost: { en: "the claude-accounts plugin stopped answering about the job", es: "El plugin de cuentas dejó de responder por la reanudación" },
};

/**
 * Why a Continuar didn't land, by an exit code or a word: { en, es }. A
 * `detail` (the plugin's, e.g. "runner gone" and the manual `claude --resume
 * <sid>`) is appended to both. An unknown code reads as a plugin failure.
 */
export function refusalText(code, detail = null) {
  const base = REFUSALS[code] ?? { en: `the claude-accounts plugin failed (exit ${code})`, es: `El plugin de cuentas falló (código ${code})` };
  if (!isText(detail)) return { ...base };
  return { en: `${base.en}: ${detail}`, es: `${base.es}: ${detail}` };
}

// ── The job ────────────────────────────────────────────────────────────────

/** Whether a request's job still runs: the plugin accepted it and its final state wasn't seen. */
export const jobLive = (job) => isObject(job) && isText(job.id) && job.final !== true;

/**
 * One `resume --status <job> --json` read as Spotlight acts on it. `poll`:
 * { code, json } (json: its stdout parsed, or null), or { error } when the
 * plugin couldn't be run. → { kind: "live", state, updatedAt } |
 * { kind: "final", state, code, detail, updatedAt } (`unknown` for exit 7:
 * a job forgotten, or never seen) | { kind: "doubt" } (no answer to go on).
 */
export function jobAnswer(poll) {
  if (!isObject(poll) || poll.error) return { kind: "doubt" };
  const json = isObject(poll.json) ? poll.json : null;
  const updatedAt = Number.isFinite(toMs(json?.updatedAt)) ? toMs(json.updatedAt) : null;
  if (json && isText(json.state)) {
    if (LIVE_JOB_STATES.includes(json.state)) return { kind: "live", state: json.state, updatedAt };
    if (Object.hasOwn(FINAL_JOB_CODES, json.state)) {
      return {
        kind: "final", state: json.state, code: FINAL_JOB_CODES[json.state], detail: isText(json.detail) ? json.detail : null, updatedAt,
      };
    }
    return { kind: "doubt" };
  }
  if (poll.code === 7) return { kind: "final", state: "unknown", code: 7, detail: null, updatedAt: null };
  return { kind: "doubt" };
}

const PERSON_KINDS = new Set(["permission", "question"]);

// The status ended a turn: done, idle, error, or blocked on something that
// isn't a person (D13's turn ends).
function endedTurn(status) {
  const state = status?.state ?? null;
  if (state === "done" || state === "idle" || state === "error") return true;
  return state === "blocked" && !PERSON_KINDS.has(status?.kind ?? null);
}

/**
 * The request's fields once the message reached its agent (a job's `done`,
 * or the message typed in without the plugin), D15: the window closes, and
 * the turn count is re-baselined so the resumed session's first turn end is
 * the one decided next (when that end already came after `doneAt`, the
 * baseline sits one below it). `term`: hc get's terminal, or null.
 */
export function resumedFields(req, term, { doneAt, now, auto = false }) {
  const fields = { resumingUntil: null, goneInWindow: false, resumeError: null, handledTurn: null, lastActivityAt: now, autoRetryAt: null };
  if (Number.isInteger(term?.turn)) {
    const already = endedTurn(term.status) && Number.isFinite(term.status_ms) && Number.isFinite(doneAt) && term.status_ms > doneAt;
    fields.requestTurn = already ? term.turn - 1 : term.turn;
  }
  // Only delivered automatic resumes count toward the 3 in a row (Orca).
  if (auto) fields.autoResumes = (req?.autoResumes ?? 0) + 1;
  return fields;
}

/**
 * What a final job state does to its request (D13, D15). `term`: hc get's
 * answer ({ terminal } | { missing } | { error }). → { release: true } when
 * the terminal is gone, or went away in the window and the job failed;
 * { resumed: true, fields } on `done`; else { fields }: paused with the
 * text, the window closed, the restart's turn ends spent.
 */
export function settleFinal(req, answer, term, now) {
  const t = term?.terminal ?? null;
  const gone = Boolean(term?.missing) || (t !== null && t.state !== "live");
  if (gone || (answer.state !== "done" && req.goneInWindow === true)) return { release: true };
  if (answer.state === "done") {
    return { resumed: true, fields: resumedFields(req, t, { doneAt: answer.updatedAt ?? now, now, auto: req.resumeJob?.auto === true }) };
  }
  const text = refusalText(answer.state, answer.detail);
  const fields = {
    resumingUntil: null,
    goneInWindow: false,
    resumeError: { code: answer.code, state: answer.state, text: text.es, at: now },
  };
  if (Number.isInteger(t?.turn)) fields.handledTurn = Math.max(t.turn, Number.isInteger(req.handledTurn) ? req.handledTurn : -Infinity);
  return { fields };
}

// ── Continuar ──────────────────────────────────────────────────────────────

/** The fields that open the resume window before Continuar acts (D13): the turn count so far is spent. */
export function windowFields(req, term, now) {
  const turns = [req?.handledTurn, term?.turn].filter(Number.isInteger);
  return {
    resumingUntil: now + RESUME_WINDOW_MS,
    handledTurn: turns.length > 0 ? Math.max(...turns) : null,
    goneInWindow: false,
    resumeError: null,
  };
}

// Auto-resume may take this pause: a usage limit, under 3 delivered in a row.
const autoAllowed = (req) => req.pauseReason === "limit" && (req.autoResumes ?? 0) < MAX_AUTO_RESUMES;

/**
 * What Continuar does for `req` (D15). `auto`: auto-resume asks; `plugin`:
 * the accounts plugin is installed; `busy`: a window being open counts as a
 * Continuar already running (the detached run that the window was opened
 * for passes false). → { kind } with:
 *   esc      a holder: Esc, then the message, same account (never auto)
 *   account  a paused agent: pick an account, the plugin's `resume` job
 *   send     a paused agent, no plugin: type the message in (never auto)
 *   reuse    its job still runs (`job`): a repeated Continuar reuses it
 *   busy     a Continuar is already running
 *   refuse   `code`: no-place | not-paused | signin | auto-holder | auto-spent | no-plugin
 */
export function continuePlan(req, { auto = false, plugin, now, busy = true }) {
  if (!req) return { kind: "refuse", code: "no-place" };
  if (jobLive(req.resumeJob)) return { kind: "reuse", job: req.resumeJob.id };
  if (busy && inResumeWindow(req, now)) return { kind: "busy" };
  if (req.state === "holding") return auto ? { kind: "refuse", code: "auto-holder" } : { kind: "esc" };
  if (req.state !== "paused") return { kind: "refuse", code: "not-paused" };
  // An expired sign-in is fixed by signing in, never by switching accounts.
  if (req.pauseReason === "signin") return { kind: "refuse", code: "signin" };
  if (auto && !autoAllowed(req)) return { kind: "refuse", code: "auto-spent" };
  if (plugin) return { kind: "account" };
  return auto ? { kind: "refuse", code: "no-plugin" } : { kind: "send" };
}

/**
 * Whether auto-resume takes this request now (D15): the setting on, a
 * `limit` pause (never `signin` or `error`), under 3 delivered in a row, no
 * window or job running, and either a pause it hasn't tried yet or its retry
 * time (60 s after the first reset) has come.
 */
export function autoResumeDue(req, { now, enabled }) {
  if (!enabled || req?.state !== "paused" || !autoAllowed(req)) return false;
  if (inResumeWindow(req, now) || jobLive(req.resumeJob)) return false;
  if (req.autoTriedPause !== req.pausedAt) return true;
  return Number.isFinite(req.autoRetryAt) && now >= req.autoRetryAt;
}

/** When auto-resume tries a pause again after "no account has limit": 60 s after the reset, never sooner than 60 s from now. */
export function autoRetryAt(returnsAt, now) {
  if (!Number.isFinite(returnsAt)) return null;
  return Math.max(returnsAt + RETRY_AFTER_RESET_MS, now + RETRY_AFTER_RESET_MS);
}

// ── The board ──────────────────────────────────────────────────────────────

// Orca's Spanish words (es.json, auto.components.sidebar.TestQueue), plus
// the sign-in this port adds (D15).
const WORDS = {
  continue: "Continuar",
  continueWith: (account) => `Continuar con ${account}`,
  resuming: "Retomando…",
  signIn: "Inicia sesión",
  continueHint: "Continuar abre su sesión con la cuenta que tenga límite y le escribe que siga donde quedó.",
  noAccountHint: "Ninguna cuenta tiene límite ahora. El botón se activa cuando vuelva la primera.",
  holderHint: "Interrumpe al agente y le escribe que siga donde quedó.",
  sendHint: "Le escribe al agente que siga donde quedó, en su misma cuenta.",
  signInHint: "Abre las cuentas de Claude para volver a iniciar sesión.",
};

/**
 * The Continuar slot of a board row (T8's continueButton). `kind`: the row's
 * section ("testing" | "paused"); `request`: the paused agent's request in
 * state.json (paused rows); `resuming`: the row's window is open; `pending`:
 * the board is running its Continuar; `plugin`: the accounts plugin is
 * installed; `pick`: pickFromText's answer (null: unknown). → null (no
 * button) or { action: "continue" | "signin", label, disabled, tooltip },
 * plus `note` on a paused row whose last Continuar didn't land.
 */
export function continueView({ kind, request = null, resuming = false, pending = false, plugin = false, pick = null, now }) {
  const running = pending || resuming || inResumeWindow(request, now) || jobLive(request?.resumeJob);
  if (kind === "testing") {
    return { action: "continue", label: running ? WORDS.resuming : WORDS.continue, disabled: running, tooltip: WORDS.holderHint };
  }
  if (kind !== "paused") return null;
  const note = !running && isText(request?.resumeError?.text) ? request.resumeError.text : null;
  const withNote = (view) => (view && note ? { ...view, note } : view);
  if (running) return { action: "continue", label: WORDS.resuming, disabled: true, tooltip: WORDS.continueHint };
  if (request?.pauseReason === "signin") {
    return withNote(plugin ? { action: "signin", label: WORDS.signIn, disabled: false, tooltip: WORDS.signInHint } : null);
  }
  if (!plugin) return withNote({ action: "continue", label: WORDS.continue, disabled: false, tooltip: WORDS.sendHint });
  if (pick === null) return withNote({ action: "continue", label: WORDS.continue, disabled: false, tooltip: WORDS.continueHint });
  if (pick.kind === "account") {
    return withNote({ action: "continue", label: WORDS.continueWith(pick.label), disabled: false, tooltip: WORDS.continueHint });
  }
  const label = Number.isFinite(pick.returnsAt) ? formatReturn(pick.returnsAt) : WORDS.continue;
  return withNote({ action: "continue", label, disabled: true, tooltip: WORDS.noAccountHint });
}
