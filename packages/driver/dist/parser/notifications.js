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
// ---------------------------------------------------------------------------
// Internal parsing helpers (byte-level, zero-copy where possible)
// ---------------------------------------------------------------------------
const PERCENT = 0x25; // %
const AT = 0x40; // @
const DOLLAR = 0x24; // $
const SPACE = 0x20; // space
const COLON = 0x3a; // :
/** Decode a contiguous ASCII slice of a Uint8Array to a string. */
function asciiSlice(arr, start, end) {
    let s = "";
    for (let i = start; i < end; i++) {
        s += String.fromCharCode(arr[i]);
    }
    return s;
}
/**
 * Decode raw bytes to a UTF-8 string (arguments after IDs tend to be UTF-8
 * names). Falls back to Latin-1 on malformed input — we must not throw.
 */
function utf8Slice(arr, start, end) {
    if (start >= end)
        return "";
    const slice = arr.subarray(start, end);
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(slice);
    }
    catch {
        // Fallback: treat as Latin-1 (never throws)
        return new TextDecoder("latin1").decode(slice);
    }
}
/** Advance past the `%keyword` prefix. Returns the position after the keyword. */
function skipKeyword(state) {
    // skip % and keyword chars until space or end-of-line
    while (state.pos < state.arr.length && state.arr[state.pos] !== SPACE) {
        state.pos++;
    }
}
/** Skip a single space. Returns false if not at a space. */
function skipSpace(state) {
    if (state.pos < state.arr.length && state.arr[state.pos] === SPACE) {
        state.pos++;
        return true;
    }
    return false;
}
/** Read a decimal integer. Returns null if none found. */
function readDecimal(state) {
    let value = 0;
    let hasDigit = false;
    while (state.pos < state.arr.length) {
        const b = state.arr[state.pos];
        if (b >= 0x30 && b <= 0x39) {
            value = value * 10 + (b - 0x30);
            hasDigit = true;
            state.pos++;
        }
        else {
            break;
        }
    }
    return hasDigit ? value : null;
}
/** Read a decimal bigint (for extended-output age which is %llu). */
function readDecimalBig(state) {
    let value = 0n;
    let hasDigit = false;
    while (state.pos < state.arr.length) {
        const b = state.arr[state.pos];
        if (b >= 0x30 && b <= 0x39) {
            value = value * 10n + BigInt(b - 0x30);
            hasDigit = true;
            state.pos++;
        }
        else {
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
function readSigilId(state, sigil) {
    if (state.pos >= state.arr.length || state.arr[state.pos] !== sigil) {
        return null;
    }
    state.pos++;
    return readDecimal(state);
}
/** Read remaining bytes as UTF-8 string (from current position to end). */
function readRest(state) {
    return utf8Slice(state.arr, state.pos, state.arr.length);
}
/** Return remaining bytes as a Uint8Array slice. */
function readRestBytes(state) {
    return state.arr.subarray(state.pos);
}
/** Read a non-space token (stops at space or end). Returns the ASCII string. */
function readToken(state) {
    const start = state.pos;
    while (state.pos < state.arr.length && state.arr[state.pos] !== SPACE) {
        state.pos++;
    }
    return asciiSlice(state.arr, start, state.pos);
}
// ---------------------------------------------------------------------------
// Per-keyword parsers
// ---------------------------------------------------------------------------
function parseOutput(token) {
    // %output %<pane> <payload>
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const paneId = readSigilId(state, PERCENT);
    if (paneId === null)
        return unknown(token);
    if (!skipSpace(state))
        return unknown(token);
    // rawPayload is the rest of the line (octal-escaped; tc-8yz decodes it)
    const rawPayload = readRestBytes(state);
    return { kind: "output", paneId, rawPayload };
}
function parseExtendedOutput(token) {
    // %extended-output %<pane> <age_us> : <payload>
    // age is in microseconds from tmux (%llu). iTerm2 divides by 1000 (ms).
    // We store as bigint microseconds; consumers can convert as needed.
    // Cross-version tolerance: unknown fields may appear between <age_us> and
    // ` : `. We scan forward to find ` : ` as the payload delimiter.
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const paneId = readSigilId(state, PERCENT);
    if (paneId === null)
        return unknown(token);
    if (!skipSpace(state))
        return unknown(token);
    const ageMs = readDecimalBig(state);
    if (ageMs === null)
        return unknown(token);
    // Scan for " : " delimiter (handles any future extra fields before it)
    const arr = token.rawLine;
    let colonPos = -1;
    for (let i = state.pos; i < arr.length - 2; i++) {
        if (arr[i] === SPACE && arr[i + 1] === COLON && arr[i + 2] === SPACE) {
            colonPos = i;
            break;
        }
    }
    if (colonPos === -1)
        return unknown(token);
    state.pos = colonPos + 3; // skip " : "
    const rawPayload = readRestBytes(state);
    return { kind: "extended-output", paneId, ageMs, rawPayload };
}
function parseWindowAdd(token, unlinked) {
    // %window-add @<win>  |  %unlinked-window-add @<win>
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const windowId = readSigilId(state, AT);
    if (windowId === null)
        return unknown(token);
    return { kind: "window-add", windowId, unlinked };
}
function parseWindowClose(token, unlinked) {
    // %window-close @<win>  |  %unlinked-window-close @<win>
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const windowId = readSigilId(state, AT);
    if (windowId === null)
        return unknown(token);
    return { kind: "window-close", windowId, unlinked };
}
function parseWindowRenamed(token, unlinked) {
    // %window-renamed @<win> <name>  (name may contain spaces)
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const windowId = readSigilId(state, AT);
    if (windowId === null)
        return unknown(token);
    if (!skipSpace(state))
        return unknown(token);
    const name = readRest(state);
    return { kind: "window-renamed", windowId, name, unlinked };
}
function parseWindowPaneChanged(token) {
    // %window-pane-changed @<win> %<pane>
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const windowId = readSigilId(state, AT);
    if (windowId === null)
        return unknown(token);
    if (!skipSpace(state))
        return unknown(token);
    const paneId = readSigilId(state, PERCENT);
    if (paneId === null)
        return unknown(token);
    return { kind: "window-pane-changed", windowId, paneId };
}
function parseSessionChanged(token) {
    // %session-changed $<sess> <name>
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const sessionId = readSigilId(state, DOLLAR);
    if (sessionId === null)
        return unknown(token);
    if (!skipSpace(state))
        return unknown(token);
    const name = readRest(state);
    return { kind: "session-changed", sessionId, name };
}
function parseClientSessionChanged(token) {
    // %client-session-changed <client> $<sess> <name>
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const clientName = readToken(state);
    if (clientName.length === 0)
        return unknown(token);
    if (!skipSpace(state))
        return unknown(token);
    const sessionId = readSigilId(state, DOLLAR);
    if (sessionId === null)
        return unknown(token);
    if (!skipSpace(state))
        return unknown(token);
    const name = readRest(state);
    return { kind: "client-session-changed", clientName, sessionId, name };
}
function parseSessionRenamed(token) {
    // Current tmux: %session-renamed $<sess> <name>
    // Older tmux (pre-3.x) may emit: %session-renamed <name> (no $id)
    // We handle both: if the first arg starts with $, treat as id+name;
    // otherwise treat the entire rest as the name with sessionId=null.
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    if (state.pos < state.arr.length && state.arr[state.pos] === DOLLAR) {
        const sessionId = readSigilId(state, DOLLAR);
        if (sessionId === null)
            return unknown(token);
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
function parseSessionsChanged(_token) {
    // %sessions-changed (no arguments)
    return { kind: "sessions-changed" };
}
function parseSessionWindowChanged(token) {
    // %session-window-changed $<sess> @<win>
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const sessionId = readSigilId(state, DOLLAR);
    if (sessionId === null)
        return unknown(token);
    if (!skipSpace(state))
        return unknown(token);
    const windowId = readSigilId(state, AT);
    if (windowId === null)
        return unknown(token);
    return { kind: "session-window-changed", sessionId, windowId };
}
function parsePaneModeChanged(token) {
    // %pane-mode-changed %<pane>
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const paneId = readSigilId(state, PERCENT);
    if (paneId === null)
        return unknown(token);
    return { kind: "pane-mode-changed", paneId };
}
function parseSubscriptionChanged(token) {
    // %subscription-changed <name> $<sess> @<win>|"-" <idx>|"-" %<pane>|"-" : <value>
    // Variants from control.c:
    //   session-level:   %subscription-changed name $S - - -  : value
    //   window-level:    %subscription-changed name $S @W idx -  : value
    //   pane-level:      %subscription-changed name $S @W idx %P : value
    //
    // Cross-version: future versions may add more fields before ` : `.
    // We parse what's stable (name, $sess, then read the " : " suffix for value).
    const arr = token.rawLine;
    const state = { arr, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    // Subscription name (no spaces — verified from tmux source)
    const name = readToken(state);
    if (name.length === 0)
        return unknown(token);
    if (!skipSpace(state))
        return unknown(token);
    // Session id
    const sessionId = readSigilId(state, DOLLAR);
    if (sessionId === null)
        return unknown(token);
    // Find the " : " delimiter to extract value (scan from current pos)
    let colonPos = -1;
    for (let i = state.pos; i < arr.length - 2; i++) {
        if (arr[i] === SPACE && arr[i + 1] === COLON && arr[i + 2] === SPACE) {
            colonPos = i;
            break;
        }
    }
    if (colonPos === -1)
        return unknown(token);
    const value = utf8Slice(arr, colonPos + 3, arr.length);
    // Parse the middle fields between $sess and " : "
    // Format: " @<win>|"-" <idx>|"-" %<pane>|"-""
    const middleStr = asciiSlice(arr, state.pos, colonPos);
    const parts = middleStr.trim().split(" ").filter((p) => p.length > 0);
    let windowId = null;
    let windowIdx = null;
    let paneId = null;
    // parts[0]: @<win> or -
    if (parts[0] !== undefined && parts[0] !== "-") {
        if (parts[0].startsWith("@")) {
            const n = parseInt(parts[0].slice(1), 10);
            if (!isNaN(n))
                windowId = n;
        }
    }
    // parts[1]: <idx> or -
    if (parts[1] !== undefined && parts[1] !== "-") {
        const n = parseInt(parts[1], 10);
        if (!isNaN(n))
            windowIdx = n;
    }
    // parts[2]: %<pane> or -
    if (parts[2] !== undefined && parts[2] !== "-") {
        if (parts[2].startsWith("%")) {
            const n = parseInt(parts[2].slice(1), 10);
            if (!isNaN(n))
                paneId = n;
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
function parsePause(token) {
    // %pause %<pane>
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const paneId = readSigilId(state, PERCENT);
    if (paneId === null)
        return unknown(token);
    return { kind: "pause", paneId };
}
function parseContinue(token) {
    // %continue %<pane>
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return unknown(token);
    const paneId = readSigilId(state, PERCENT);
    if (paneId === null)
        return unknown(token);
    return { kind: "continue", paneId };
}
function parseExit(token) {
    // %exit [reason]
    const state = { arr: token.rawLine, pos: 0 };
    skipKeyword(state);
    if (!skipSpace(state))
        return { kind: "exit", reason: null };
    const reason = readRest(state);
    return { kind: "exit", reason: reason.length > 0 ? reason : null };
}
function unknown(token) {
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
export function parseNotification(token) {
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
//# sourceMappingURL=notifications.js.map