/**
 * tmux -CC notification semantic parser.
 *
 * Parses `NotificationToken`s emitted by the tokenizer into a typed
 * discriminated-union of notification events. This is SOUTH-facing — it
 * interprets tmux's control-mode notification vocabulary; no I/O.
 *
 * # Notification formats (verified against tmux control-notify.c / control.c)
 *
 * ## Output
 *   %output %<pane> <octal-escaped-payload>
 *   %extended-output %<pane> <age_ms> : <octal-escaped-payload>
 *
 * The payload is octal-escaped (characters < 0x20 or '\\' are written as
 * \NNN). Decoding is the responsibility of tc-8yz (output-codec.ts). This
 * module emits the raw payload bytes and documents the integration point.
 *
 * ## Window
 *   %window-add @<win>
 *   %window-close @<win>
 *   %unlinked-window-add @<win>
 *   %unlinked-window-close @<win>
 *   %window-renamed @<win> <name>          (name may contain spaces)
 *   %unlinked-window-renamed @<win> <name>
 *   %window-pane-changed @<win> %<pane>
 *
 * ## Session
 *   %session-changed $<sess> <name>
 *   %client-session-changed <client> $<sess> <name>
 *   %session-renamed $<sess> <name>
 *   %sessions-changed
 *   %session-window-changed $<sess> @<win>
 *
 * ## Pane
 *   %pane-mode-changed %<pane>
 *
 * ## Subscription
 *   %subscription-changed <name> $<sess> @<win> <idx> %<pane> : <value>
 *   %subscription-changed <name> $<sess> @<win> <idx> - : <value>
 *   %subscription-changed <name> $<sess> - - - : <value>
 *   (session-level subscription; window/pane fields are "-" when absent)
 *
 * ## Flow control
 *   %pause %<pane>
 *   %continue %<pane>
 *
 * ## Lifecycle
 *   %exit [reason]   (reason is optional — may be absent)
 *
 * ## Unknown
 *   Any other %-keyword → UnknownNotification (never fatal).
 *
 * # ID conventions
 *   %N  → pane   (paneId: number)
 *   @N  → window (windowId: number)
 *   $N  → session (sessionId: number)
 * IDs are stored as plain numbers without the sigil.
 *
 * @module parser/notifications
 */

import type { NotificationToken } from "./tokenizer.js";
import type { WindowId } from "../ids.js";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

// --- Output ----------------------------------------------------------------

/**
 * %output %<pane> <payload>
 *
 * `rawPayload` is the octal-escaped payload bytes exactly as received from
 * tmux (the suffix of the rawLine after `%output %N `). To get decoded
 * terminal bytes, run through tc-8yz's `decodeOutputPayload()` at the
 * integration point.
 *
 * NOTE (tc-wvu): tc-8yz (output-codec.ts) is a concurrent bead. At TL
 * reconcile time the integration point wires `rawPayload` through
 * `decodeOutputPayload`. This module emits raw bytes to keep the codec in
 * one place and avoid duplicate divergent implementations.
 */
export interface OutputNotification {
  readonly kind: "output";
  readonly paneId: number;
  /** Raw octal-escaped payload; decode via tc-8yz output-codec.ts. */
  readonly rawPayload: Uint8Array;
}

/**
 * %extended-output %<pane> <age_ms> : <payload>
 *
 * Same payload convention as OutputNotification. `ageMs` is the age of the
 * data in milliseconds (tmux reports microseconds as %llu; iTerm2 divides
 * by 1000 — we keep milliseconds).
 *
 * The `: ` separator between age and payload is a fixed delimiter (any
 * fields added by future tmux versions appear between `age_ms` and `: `).
 * We skip unknown intermediate fields by scanning for ` : ` (space-colon-space).
 */
export interface ExtendedOutputNotification {
  readonly kind: "extended-output";
  readonly paneId: number;
  /** Age of the data in milliseconds (from tmux's microsecond counter). */
  readonly ageMs: bigint;
  /** Raw octal-escaped payload; decode via tc-8yz output-codec.ts. */
  readonly rawPayload: Uint8Array;
}

// --- Window ----------------------------------------------------------------

/**
 * %window-add @<win>
 * %unlinked-window-add @<win>
 */
export interface WindowAddNotification {
  readonly kind: "window-add";
  readonly windowId: number;
  /** True when the keyword was %unlinked-window-add. */
  readonly unlinked: boolean;
}

/**
 * %window-close @<win>
 * %unlinked-window-close @<win>
 */
export interface WindowCloseNotification {
  readonly kind: "window-close";
  readonly windowId: number;
  readonly unlinked: boolean;
}

/**
 * %window-renamed @<win> <name>
 * %unlinked-window-renamed @<win> <name>
 * Name may contain spaces — rest-of-line after the window id.
 */
export interface WindowRenamedNotification {
  readonly kind: "window-renamed";
  readonly windowId: number;
  readonly name: string;
  readonly unlinked: boolean;
}

/**
 * %window-pane-changed @<win> %<pane>
 */
export interface WindowPaneChangedNotification {
  readonly kind: "window-pane-changed";
  readonly windowId: number;
  readonly paneId: number;
}

// --- Session ---------------------------------------------------------------

/**
 * %session-changed $<sess> <name>
 */
export interface SessionChangedNotification {
  readonly kind: "session-changed";
  readonly sessionId: number;
  readonly name: string;
}

/**
 * %client-session-changed <client> $<sess> <name>
 */
export interface ClientSessionChangedNotification {
  readonly kind: "client-session-changed";
  readonly clientName: string;
  readonly sessionId: number;
  readonly name: string;
}

/**
 * %session-renamed $<sess> <name>
 * (tmux ≥3.x; older versions may omit $id — handled gracefully by treating
 * the entire argument as the name if the first token doesn't start with $.)
 */
export interface SessionRenamedNotification {
  readonly kind: "session-renamed";
  readonly sessionId: number | null;
  readonly name: string;
}

/**
 * %sessions-changed
 * No arguments; signals any session list change.
 */
export interface SessionsChangedNotification {
  readonly kind: "sessions-changed";
}

/**
 * %session-window-changed $<sess> @<win>
 */
export interface SessionWindowChangedNotification {
  readonly kind: "session-window-changed";
  readonly sessionId: number;
  readonly windowId: number;
}

// --- Pane ------------------------------------------------------------------

/**
 * %pane-mode-changed %<pane>
 */
export interface PaneModeChangedNotification {
  readonly kind: "pane-mode-changed";
  readonly paneId: number;
}

// --- Subscription ----------------------------------------------------------

/**
 * %subscription-changed <name> $<sess> @<win>|"-" <idx>|"-" %<pane>|"-" : <value>
 *
 * The window/idx/pane fields are "-" when not applicable to the subscription
 * type (session-level subscriptions omit window/pane context; window-level
 * subscriptions omit pane). We represent absent fields as null.
 */
export interface SubscriptionChangedNotification {
  readonly kind: "subscription-changed";
  /** Subscription name as registered by the client. */
  readonly name: string;
  readonly sessionId: number;
  readonly windowId: number | null;
  /** Winlink index within the session (present when windowId is present). */
  readonly windowIdx: number | null;
  readonly paneId: number | null;
  /** The formatted value (everything after `: `). */
  readonly value: string;
}

// --- Flow control ----------------------------------------------------------

/**
 * %pause %<pane>
 */
export interface PauseNotification {
  readonly kind: "pause";
  readonly paneId: number;
}

/**
 * %continue %<pane>
 */
export interface ContinueNotification {
  readonly kind: "continue";
  readonly paneId: number;
}

// --- Lifecycle -------------------------------------------------------------

/**
 * %exit [reason]
 * Reason is optional. When present it is a human-readable string.
 */
export interface ExitNotification {
  readonly kind: "exit";
  readonly reason: string | null;
}

// --- Unknown ---------------------------------------------------------------

/**
 * Any %-keyword not matched above. Never fatal — graceful degradation.
 */
export interface UnknownNotification {
  readonly kind: "unknown";
  readonly keyword: string;
  readonly rawLine: Uint8Array;
}

// --- Internal (synthetic, never from tmux wire) ----------------------------

/**
 * Synthetic internal event: the daemon applied a set-synchronize-panes command
 * and assumes tmux accepted it.
 *
 * This event is NEVER parsed from tmux control-mode output — it is injected by
 * input-path.ts after sending `set-option -wt @N synchronize-panes on|off` to
 * tmux (tc-7xv.12 optimistic-update pattern).
 *
 * Assumption: tmux applied the option. If tmux rejects it (e.g. no such
 * window), the model will be stale until the next bootstrap. Error reversal
 * is out of scope — document this as a known limitation.
 */
export interface InternalWindowSyncSetNotification {
  readonly kind: "internal:set-window-sync";
  readonly windowId: WindowId;
  readonly on: boolean;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type NotificationEvent =
  | OutputNotification
  | ExtendedOutputNotification
  | WindowAddNotification
  | WindowCloseNotification
  | WindowRenamedNotification
  | WindowPaneChangedNotification
  | SessionChangedNotification
  | ClientSessionChangedNotification
  | SessionRenamedNotification
  | SessionsChangedNotification
  | SessionWindowChangedNotification
  | PaneModeChangedNotification
  | SubscriptionChangedNotification
  | PauseNotification
  | ContinueNotification
  | ExitNotification
  | UnknownNotification
  | InternalWindowSyncSetNotification;

// ---------------------------------------------------------------------------
// Internal parsing helpers (byte-level, zero-copy where possible)
// ---------------------------------------------------------------------------

const PERCENT = 0x25; // %
const AT = 0x40; // @
const DOLLAR = 0x24; // $
const SPACE = 0x20; // space
const COLON = 0x3a; // :

/** Decode a contiguous ASCII slice of a Uint8Array to a string. */
function asciiSlice(arr: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) {
    s += String.fromCharCode(arr[i]!);
  }
  return s;
}

/**
 * Decode raw bytes to a UTF-8 string (arguments after IDs tend to be UTF-8
 * names). Falls back to Latin-1 on malformed input — we must not throw.
 */
function utf8Slice(arr: Uint8Array, start: number, end: number): string {
  if (start >= end) return "";
  const slice = arr.subarray(start, end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    // Fallback: treat as Latin-1 (never throws)
    return new TextDecoder("latin1").decode(slice);
  }
}

interface ParseState {
  arr: Uint8Array;
  pos: number;
}

/** Advance past the `%keyword` prefix. Returns the position after the keyword. */
function skipKeyword(state: ParseState): void {
  // skip % and keyword chars until space or end-of-line
  while (state.pos < state.arr.length && state.arr[state.pos] !== SPACE) {
    state.pos++;
  }
}

/** Skip a single space. Returns false if not at a space. */
function skipSpace(state: ParseState): boolean {
  if (state.pos < state.arr.length && state.arr[state.pos] === SPACE) {
    state.pos++;
    return true;
  }
  return false;
}

/** Read a decimal integer. Returns null if none found. */
function readDecimal(state: ParseState): number | null {
  let value = 0;
  let hasDigit = false;
  while (state.pos < state.arr.length) {
    const b = state.arr[state.pos]!;
    if (b >= 0x30 && b <= 0x39) {
      value = value * 10 + (b - 0x30);
      hasDigit = true;
      state.pos++;
    } else {
      break;
    }
  }
  return hasDigit ? value : null;
}

/** Read a decimal bigint (for extended-output age which is %llu). */
function readDecimalBig(state: ParseState): bigint | null {
  let value = 0n;
  let hasDigit = false;
  while (state.pos < state.arr.length) {
    const b = state.arr[state.pos]!;
    if (b >= 0x30 && b <= 0x39) {
      value = value * 10n + BigInt(b - 0x30);
      hasDigit = true;
      state.pos++;
    } else {
      break;
    }
  }
  return hasDigit ? value : null;
}

/**
 * Expect a sigil byte followed by a decimal integer.
 * E.g. `%12`, `@3`, `$0`.
 * Returns null if the expected sigil is not present.
 */
function readSigilId(state: ParseState, sigil: number): number | null {
  if (state.pos >= state.arr.length || state.arr[state.pos] !== sigil) {
    return null;
  }
  state.pos++;
  return readDecimal(state);
}

/** Read remaining bytes as UTF-8 string (from current position to end). */
function readRest(state: ParseState): string {
  return utf8Slice(state.arr, state.pos, state.arr.length);
}

/** Return remaining bytes as a Uint8Array slice. */
function readRestBytes(state: ParseState): Uint8Array {
  return state.arr.subarray(state.pos);
}

/** Read a non-space token (stops at space or end). Returns the ASCII string. */
function readToken(state: ParseState): string {
  const start = state.pos;
  while (state.pos < state.arr.length && state.arr[state.pos] !== SPACE) {
    state.pos++;
  }
  return asciiSlice(state.arr, start, state.pos);
}

// ---------------------------------------------------------------------------
// Per-keyword parsers
// ---------------------------------------------------------------------------

function parseOutput(token: NotificationToken): OutputNotification | UnknownNotification {
  // %output %<pane> <payload>
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const paneId = readSigilId(state, PERCENT);
  if (paneId === null) return unknown(token);
  if (!skipSpace(state)) return unknown(token);
  // rawPayload is the rest of the line (octal-escaped; tc-8yz decodes it)
  const rawPayload = readRestBytes(state);
  return { kind: "output", paneId, rawPayload };
}

function parseExtendedOutput(
  token: NotificationToken,
): ExtendedOutputNotification | UnknownNotification {
  // %extended-output %<pane> <age_us> : <payload>
  // age is in microseconds from tmux (%llu). iTerm2 divides by 1000 (ms).
  // We store as bigint microseconds; consumers can convert as needed.
  // Cross-version tolerance: unknown fields may appear between <age_us> and
  // ` : `. We scan forward to find ` : ` as the payload delimiter.
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const paneId = readSigilId(state, PERCENT);
  if (paneId === null) return unknown(token);
  if (!skipSpace(state)) return unknown(token);
  const ageMs = readDecimalBig(state);
  if (ageMs === null) return unknown(token);

  // Scan for " : " delimiter (handles any future extra fields before it)
  const arr = token.rawLine;
  let colonPos = -1;
  for (let i = state.pos; i < arr.length - 2; i++) {
    if (arr[i] === SPACE && arr[i + 1] === COLON && arr[i + 2] === SPACE) {
      colonPos = i;
      break;
    }
  }
  if (colonPos === -1) return unknown(token);
  state.pos = colonPos + 3; // skip " : "
  const rawPayload = readRestBytes(state);
  return { kind: "extended-output", paneId, ageMs, rawPayload };
}

function parseWindowAdd(
  token: NotificationToken,
  unlinked: boolean,
): WindowAddNotification | UnknownNotification {
  // %window-add @<win>  |  %unlinked-window-add @<win>
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const windowId = readSigilId(state, AT);
  if (windowId === null) return unknown(token);
  return { kind: "window-add", windowId, unlinked };
}

function parseWindowClose(
  token: NotificationToken,
  unlinked: boolean,
): WindowCloseNotification | UnknownNotification {
  // %window-close @<win>  |  %unlinked-window-close @<win>
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const windowId = readSigilId(state, AT);
  if (windowId === null) return unknown(token);
  return { kind: "window-close", windowId, unlinked };
}

function parseWindowRenamed(
  token: NotificationToken,
  unlinked: boolean,
): WindowRenamedNotification | UnknownNotification {
  // %window-renamed @<win> <name>  (name may contain spaces)
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const windowId = readSigilId(state, AT);
  if (windowId === null) return unknown(token);
  if (!skipSpace(state)) return unknown(token);
  const name = readRest(state);
  return { kind: "window-renamed", windowId, name, unlinked };
}

function parseWindowPaneChanged(
  token: NotificationToken,
): WindowPaneChangedNotification | UnknownNotification {
  // %window-pane-changed @<win> %<pane>
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const windowId = readSigilId(state, AT);
  if (windowId === null) return unknown(token);
  if (!skipSpace(state)) return unknown(token);
  const paneId = readSigilId(state, PERCENT);
  if (paneId === null) return unknown(token);
  return { kind: "window-pane-changed", windowId, paneId };
}

function parseSessionChanged(
  token: NotificationToken,
): SessionChangedNotification | UnknownNotification {
  // %session-changed $<sess> <name>
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const sessionId = readSigilId(state, DOLLAR);
  if (sessionId === null) return unknown(token);
  if (!skipSpace(state)) return unknown(token);
  const name = readRest(state);
  return { kind: "session-changed", sessionId, name };
}

function parseClientSessionChanged(
  token: NotificationToken,
): ClientSessionChangedNotification | UnknownNotification {
  // %client-session-changed <client> $<sess> <name>
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const clientName = readToken(state);
  if (clientName.length === 0) return unknown(token);
  if (!skipSpace(state)) return unknown(token);
  const sessionId = readSigilId(state, DOLLAR);
  if (sessionId === null) return unknown(token);
  if (!skipSpace(state)) return unknown(token);
  const name = readRest(state);
  return { kind: "client-session-changed", clientName, sessionId, name };
}

function parseSessionRenamed(
  token: NotificationToken,
): SessionRenamedNotification | UnknownNotification {
  // Current tmux: %session-renamed $<sess> <name>
  // Older tmux (pre-3.x) may emit: %session-renamed <name> (no $id)
  // We handle both: if the first arg starts with $, treat as id+name;
  // otherwise treat the entire rest as the name with sessionId=null.
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);

  if (state.pos < state.arr.length && state.arr[state.pos] === DOLLAR) {
    const sessionId = readSigilId(state, DOLLAR);
    if (sessionId === null) return unknown(token);
    if (!skipSpace(state)) {
      // No name after id — tolerate; name is empty
      return { kind: "session-renamed", sessionId, name: "" };
    }
    const name = readRest(state);
    return { kind: "session-renamed", sessionId, name };
  }

  // Older format: no $id prefix
  const name = readRest(state);
  return { kind: "session-renamed", sessionId: null, name };
}

function parseSessionsChanged(
  _token: NotificationToken,
): SessionsChangedNotification {
  // %sessions-changed (no arguments)
  return { kind: "sessions-changed" };
}

function parseSessionWindowChanged(
  token: NotificationToken,
): SessionWindowChangedNotification | UnknownNotification {
  // %session-window-changed $<sess> @<win>
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const sessionId = readSigilId(state, DOLLAR);
  if (sessionId === null) return unknown(token);
  if (!skipSpace(state)) return unknown(token);
  const windowId = readSigilId(state, AT);
  if (windowId === null) return unknown(token);
  return { kind: "session-window-changed", sessionId, windowId };
}

function parsePaneModeChanged(
  token: NotificationToken,
): PaneModeChangedNotification | UnknownNotification {
  // %pane-mode-changed %<pane>
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const paneId = readSigilId(state, PERCENT);
  if (paneId === null) return unknown(token);
  return { kind: "pane-mode-changed", paneId };
}

function parseSubscriptionChanged(
  token: NotificationToken,
): SubscriptionChangedNotification | UnknownNotification {
  // %subscription-changed <name> $<sess> @<win>|"-" <idx>|"-" %<pane>|"-" : <value>
  // Variants from control.c:
  //   session-level:   %subscription-changed name $S - - -  : value
  //   window-level:    %subscription-changed name $S @W idx -  : value
  //   pane-level:      %subscription-changed name $S @W idx %P : value
  //
  // Cross-version: future versions may add more fields before ` : `.
  // We parse what's stable (name, $sess, then read the " : " suffix for value).
  const arr = token.rawLine;
  const state: ParseState = { arr, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);

  // Subscription name (no spaces — verified from tmux source)
  const name = readToken(state);
  if (name.length === 0) return unknown(token);
  if (!skipSpace(state)) return unknown(token);

  // Session id
  const sessionId = readSigilId(state, DOLLAR);
  if (sessionId === null) return unknown(token);

  // Find the " : " delimiter to extract value (scan from current pos)
  let colonPos = -1;
  for (let i = state.pos; i < arr.length - 2; i++) {
    if (arr[i] === SPACE && arr[i + 1] === COLON && arr[i + 2] === SPACE) {
      colonPos = i;
      break;
    }
  }
  if (colonPos === -1) return unknown(token);
  const value = utf8Slice(arr, colonPos + 3, arr.length);

  // Parse the middle fields between $sess and " : "
  // Format: " @<win>|"-" <idx>|"-" %<pane>|"-""
  const middleStr = asciiSlice(arr, state.pos, colonPos);
  const parts = middleStr.trim().split(" ").filter((p) => p.length > 0);

  let windowId: number | null = null;
  let windowIdx: number | null = null;
  let paneId: number | null = null;

  // parts[0]: @<win> or -
  if (parts[0] !== undefined && parts[0] !== "-") {
    if (parts[0].startsWith("@")) {
      const n = parseInt(parts[0].slice(1), 10);
      if (!isNaN(n)) windowId = n;
    }
  }
  // parts[1]: <idx> or -
  if (parts[1] !== undefined && parts[1] !== "-") {
    const n = parseInt(parts[1], 10);
    if (!isNaN(n)) windowIdx = n;
  }
  // parts[2]: %<pane> or -
  if (parts[2] !== undefined && parts[2] !== "-") {
    if (parts[2].startsWith("%")) {
      const n = parseInt(parts[2].slice(1), 10);
      if (!isNaN(n)) paneId = n;
    }
  }

  return {
    kind: "subscription-changed",
    name,
    sessionId,
    windowId,
    windowIdx,
    paneId,
    value,
  };
}

function parsePause(
  token: NotificationToken,
): PauseNotification | UnknownNotification {
  // %pause %<pane>
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const paneId = readSigilId(state, PERCENT);
  if (paneId === null) return unknown(token);
  return { kind: "pause", paneId };
}

function parseContinue(
  token: NotificationToken,
): ContinueNotification | UnknownNotification {
  // %continue %<pane>
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return unknown(token);
  const paneId = readSigilId(state, PERCENT);
  if (paneId === null) return unknown(token);
  return { kind: "continue", paneId };
}

function parseExit(token: NotificationToken): ExitNotification {
  // %exit [reason]
  const state: ParseState = { arr: token.rawLine, pos: 0 };
  skipKeyword(state);
  if (!skipSpace(state)) return { kind: "exit", reason: null };
  const reason = readRest(state);
  return { kind: "exit", reason: reason.length > 0 ? reason : null };
}

function unknown(token: NotificationToken): UnknownNotification {
  return { kind: "unknown", keyword: token.keyword, rawLine: token.rawLine };
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * Parse a `NotificationToken` into a typed `NotificationEvent`.
 *
 * Dispatches on `token.keyword`. Unknown keywords return an `UnknownNotification`
 * rather than throwing — graceful degradation for newer/unknown tmux versions.
 *
 * All parsers are tolerant of extra trailing fields (cross-version drift):
 * they read only the fields they expect and ignore the remainder.
 *
 * @param token - A notification token from the tokenizer (tc-ckw).
 * @returns A typed notification event.
 */
export function parseNotification(token: NotificationToken): NotificationEvent {
  switch (token.keyword) {
    case "output":
      return parseOutput(token);

    case "extended-output":
      return parseExtendedOutput(token);

    case "window-add":
      return parseWindowAdd(token, false);

    case "unlinked-window-add":
      return parseWindowAdd(token, true);

    case "window-close":
      return parseWindowClose(token, false);

    case "unlinked-window-close":
      return parseWindowClose(token, true);

    case "window-renamed":
      return parseWindowRenamed(token, false);

    case "unlinked-window-renamed":
      return parseWindowRenamed(token, true);

    case "window-pane-changed":
      return parseWindowPaneChanged(token);

    case "session-changed":
      return parseSessionChanged(token);

    case "client-session-changed":
      return parseClientSessionChanged(token);

    case "session-renamed":
      return parseSessionRenamed(token);

    case "sessions-changed":
      return parseSessionsChanged(token);

    case "session-window-changed":
      return parseSessionWindowChanged(token);

    case "pane-mode-changed":
      return parsePaneModeChanged(token);

    case "subscription-changed":
      return parseSubscriptionChanged(token);

    case "pause":
      return parsePause(token);

    case "continue":
      return parseContinue(token);

    case "exit":
      return parseExit(token);

    default:
      return unknown(token);
  }
}
