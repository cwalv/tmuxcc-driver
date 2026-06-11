/**
 * tmux %output / %extended-output payload codec.
 *
 * # Confirmed tmux escaping rule (control.c:638–648, tmux source)
 *
 * When writing a pane output payload, tmux iterates over each byte of the
 * pane's raw output as `u_char` (unsigned, 0–255) and applies:
 *
 *   if (new_data[i] < ' ' || new_data[i] == '\\')
 *       evbuffer_add_printf(message, "\\%03o", new_data[i]);
 *   else
 *       pass through literally
 *
 * In other words:
 *   - Bytes 0x00–0x1F (control chars, including LF/CR/NUL/TAB) → `\NNN` (backslash + exactly 3 octal digits)
 *   - Byte  0x5C (backslash) → `\134`
 *   - Bytes 0x20–0x5B, 0x5D–0xFF → passed through literally (including 0x7F–0xFF)
 *
 * Critical: 0x7F–0xFF are NOT escaped. The comparison `u_char < ' '` is an
 * unsigned comparison, so the high-byte range is entirely above the threshold.
 * This means %output payloads can contain raw bytes 0x80–0xFF, which are valid
 * output payload bytes but produce invalid UTF-8. NEVER convert to a JS string;
 * always decode directly to/from Uint8Array.
 *
 * # Decoder: decodeOutputPayload
 *
 * Given the payload byte slice (the part after "%output %<paneId> "), returns
 * the decoded Uint8Array of original pane bytes.
 *
 * # Encoder: encodeOutputPayload
 *
 * Mirrors tmux's encoding. Primarily for tests (round-trip / fuzz). The encoder
 * is exported for use in tests; production code only needs the decoder.
 *
 * # Helper: parseOutputNotification
 *
 * Takes a NotificationToken whose keyword is "output" (or "extended-output")
 * and returns { paneId, bytes }. Useful for tc-wvu and downstream consumers
 * that receive a NotificationToken and need the decoded pane content.
 *
 * @module parser/output-codec
 */

import type { NotificationToken } from "./tokenizer.js";

// ---------------------------------------------------------------------------
// ASCII constants (used in decoder hot path)
// ---------------------------------------------------------------------------

const BACKSLASH = 0x5c; // '\'
const PERCENT = 0x25; //  '%'
const SPACE = 0x20; //    ' '

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Decode a tmux `%output` payload byte slice into the original pane bytes.
 *
 * The input is the raw bytes of the payload region only — i.e. the bytes that
 * come after `%output %<paneId> ` (or `%extended-output %<paneId> <latency> : `).
 * Callers are responsible for slicing out the payload region; see
 * `parseOutputNotification` for a convenience wrapper that handles the full
 * notification line.
 *
 * Escaping handled:
 *   - `\NNN` (backslash + exactly 3 octal digits 0–7) → byte value NNN (octal)
 *   - All other bytes → passed through as-is (including 0x7F–0xFF)
 *
 * Invalid escape sequences (e.g. backslash followed by fewer than 3 octal
 * digits, or a non-octal digit) are treated defensively: the backslash is
 * emitted as 0x5C and scanning continues from the next byte. This shouldn't
 * occur in well-formed tmux output, but a corrupt or partial buffer shouldn't
 * silently drop bytes.
 *
 * @param payload - The escaped payload bytes (Uint8Array slice).
 * @returns Decoded raw pane bytes (may contain arbitrary values 0x00–0xFF).
 */
export function decodeOutputPayload(payload: Uint8Array): Uint8Array {
  // Upper bound: decoded length ≤ payload length (escapes expand ≥ 1 input
  // byte to 4 characters, so decoding always shrinks or maintains length).
  const out = new Uint8Array(payload.length);
  let outLen = 0;
  let i = 0;

  while (i < payload.length) {
    const b = payload[i]!;

    if (b !== BACKSLASH) {
      // Fast path: literal byte.
      out[outLen++] = b;
      i++;
      continue;
    }

    // Backslash: expect exactly 3 octal digits.
    if (
      i + 3 < payload.length &&
      isOctalDigit(payload[i + 1]!) &&
      isOctalDigit(payload[i + 2]!) &&
      isOctalDigit(payload[i + 3]!)
    ) {
      const octalValue =
        ((payload[i + 1]! - 0x30) << 6) |
        ((payload[i + 2]! - 0x30) << 3) |
        (payload[i + 3]! - 0x30);
      out[outLen++] = octalValue & 0xff;
      i += 4;
    } else {
      // Malformed escape: emit the backslash literally and advance past it.
      out[outLen++] = BACKSLASH;
      i++;
    }
  }

  // Return a correctly sized view (no copy — subarray shares the buffer).
  return out.subarray(0, outLen);
}

/** Returns true if b is an ASCII octal digit ('0'–'7'). */
function isOctalDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x37;
}

// ---------------------------------------------------------------------------
// Encoder (mirrors tmux's control.c rule — used for round-trip / fuzz tests)
// ---------------------------------------------------------------------------

/**
 * Encode raw pane bytes into the tmux `%output` payload escape format.
 *
 * This mirrors the exact rule from tmux's `control.c:638-648`:
 *   - Bytes < 0x20 (control chars) → `\NNN` (backslash + 3 octal digits)
 *   - Byte 0x5C (backslash) → `\134`
 *   - All other bytes (0x20–0x5B, 0x5D–0xFF) → literal (as-is)
 *
 * The function returns a Uint8Array of the encoded payload. Note that the
 * output may contain raw bytes ≥ 0x80 (high bytes pass through literally,
 * just as tmux emits them), so the result is NOT a valid UTF-8 string in
 * general. In practice test code can compare Uint8Arrays directly.
 *
 * @param raw - Raw pane bytes to encode.
 * @returns Encoded payload bytes in tmux's backslash-octal format.
 */
export function encodeOutputPayload(raw: Uint8Array): Uint8Array {
  // Worst case: every byte escapes to 4 bytes.
  const out = new Uint8Array(raw.length * 4);
  let outLen = 0;

  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!;

    if (b < 0x20 || b === BACKSLASH) {
      // Octal-escape.
      out[outLen++] = BACKSLASH; // '\'
      out[outLen++] = 0x30 + ((b >> 6) & 0x7); // hundreds octal digit
      out[outLen++] = 0x30 + ((b >> 3) & 0x7); // tens octal digit
      out[outLen++] = 0x30 + (b & 0x7); // units octal digit
    } else {
      // Literal byte (0x20–0x5B, 0x5D–0xFF).
      out[outLen++] = b;
    }
  }

  return out.subarray(0, outLen);
}

// ---------------------------------------------------------------------------
// Convenience helper for NotificationToken consumers
// ---------------------------------------------------------------------------

/**
 * Result of parsing a `%output` or `%extended-output` notification line.
 */
export interface OutputNotification {
  /** Numeric pane ID (the number after the `%` sigil). */
  readonly paneId: number;
  /**
   * Decoded raw pane bytes. May contain any value 0x00–0xFF, including
   * invalid UTF-8. Never convert to a JS string without an explicit
   * encoding-aware transformation.
   */
  readonly bytes: Uint8Array;
}

/**
 * Parse a `%output %<paneId> <payload>` or `%extended-output %<paneId> <latency> : <payload>`
 * notification token into a structured result with decoded pane bytes.
 *
 * Returns `null` if the line is malformed (missing pane ID, bad format, etc.).
 * Callers should check the token's `keyword` before calling; this function
 * handles both "output" and "extended-output" keywords.
 *
 * Line formats (rawLine starts with `%keyword`):
 *
 *   %output %<paneId> <escaped-payload>\n        (standard)
 *   %extended-output %<paneId> <latency> : <escaped-payload>\n  (pause mode)
 *
 * The payload region is the part after the last field separator described above.
 * For %output: bytes after `%output %<paneId> `.
 * For %extended-output: bytes after the `: ` separator.
 *
 * @param token - A NotificationToken with keyword "output" or "extended-output".
 * @returns Parsed { paneId, bytes } or null on malformed input.
 */
export function parseOutputNotification(
  token: NotificationToken,
): OutputNotification | null {
  const line = token.rawLine;

  // line starts with b"%keyword" (no trailing space yet).
  // We need to skip past "%keyword " to find "%<paneId>".
  let i = 0;

  // Skip past the keyword (e.g. "%output" or "%extended-output").
  while (i < line.length && line[i] !== SPACE) i++;
  if (i >= line.length) return null;
  i++; // skip space after keyword

  // Expect '%' sigil before pane ID.
  if (i >= line.length || line[i] !== PERCENT) return null;
  i++; // skip '%'

  // Read decimal pane ID.
  let paneId = 0;
  let hasDigit = false;
  while (i < line.length && line[i]! >= 0x30 && line[i]! <= 0x39) {
    paneId = paneId * 10 + (line[i]! - 0x30);
    hasDigit = true;
    i++;
  }
  if (!hasDigit) return null;

  if (token.keyword === "extended-output") {
    // Format: %extended-output %<paneId> <latency> : <payload>
    // Skip space + latency field + space + colon + space.
    if (i >= line.length || line[i] !== SPACE) return null;
    i++; // skip space
    // Skip latency digits.
    while (i < line.length && line[i]! >= 0x30 && line[i]! <= 0x39) i++;
    // Expect " : " separator.
    if (i + 2 >= line.length) return null;
    if (line[i] !== SPACE || line[i + 1] !== 0x3a /* ':' */ || line[i + 2] !== SPACE)
      return null;
    i += 3;
  } else {
    // Format: %output %<paneId> <payload>
    if (i >= line.length || line[i] !== SPACE) return null;
    i++; // skip space before payload
  }

  // Remaining bytes are the escaped payload.
  const payload = line.subarray(i);
  const bytes = decodeOutputPayload(payload);
  return { paneId, bytes };
}
