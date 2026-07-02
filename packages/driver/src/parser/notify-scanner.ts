/**
 * Pane attention/status escape scanner (tc-76m8.1, user-stories.md S9).
 *
 * A per-pane streaming state machine that recognises notification/status
 * escapes on a pane's DECODED raw pty byte stream and reports them as typed
 * {@link PaneNotifyDetection}s. It is a PURE OBSERVER — it never modifies,
 * strips, or buffers the render-path bytes; the caller passes the same decoded
 * chunk on to the demux untouched. The bead's contract: "unrecognized/malformed
 * bytes pass through untouched, never dropped from the render path."
 *
 * # Recognised signals
 *
 *   BEL (0x07, outside any string)     → { kind: "bell" }                Tier 1
 *   ESC ] 9 ; <body> ST                → { kind: "osc9", source: osc9 }  Tier 1
 *   ESC ] 777 ; notify ; <t> ; <b> ST  → { kind: "osc9", source: osc777 }Tier 1
 *   ESC ] 9 ; 4 ; <st> ; <pr> ST       → { kind: "progress" }            Tier 2
 *   ESC ] 633 ; D ; <code> ST          → { kind: "cmd-exit" }            Tier 2
 *
 * ST (string terminator) is BEL (0x07) OR ESC \ (0x1B 0x5C), per xterm.
 *
 * OSC 0/2 (window/icon title) are NOT recognised here — they are handled by the
 * OSC title sniffer (tc-2mn8) and carry no attention signal. All other OSC
 * numbers pass through without emitting.
 *
 * OSC 1337 (iTerm2): iTerm2's public desktop-notification path is OSC 9 (which
 * we DO recognise); OSC 1337 is a grab-bag of proprietary NON-notification
 * controls (SetMark, CursorShape, file transfer, ...). Blanket-emitting a
 * Tier-1 notification for every 1337 would spam the OS notification centre, so
 * we recognise it STRUCTURALLY (parse + consume it as an OSC so it never
 * corrupts the state machine) but do not emit. See the bd note on tc-76m8.1.
 *
 * # Bounded across chunk boundaries
 *
 * The scanner instance is per-pane and persists its state (and a small
 * partial-sequence buffer) between `scan()` calls, so a sequence split across
 * `%output` chunks is recognised. The buffer is bounded by {@link MAX_OSC_BYTES}
 * — an over-long unterminated sequence is a garbage abort (reset to IDLE),
 * never unbounded growth. A BEL that terminates a DCS/APC/PM/SOS string is
 * consumed by the STRING state and NOT miscounted as a bell.
 *
 * # Emission volume
 *
 * The scanner emits EVERY recognised signal — rate-limiting/coalescing against
 * storms is a SEPARATE concern ({@link PaneNotifyRateLimiter}), applied by the
 * pipeline at emit time so detection stays pure and unit-testable.
 *
 * @module parser/notify-scanner
 */

import type { PaneNotifyKind, PaneNotifyPayload, PaneProgressState } from "@tmuxcc/protocol";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BEL = 0x07; // BEL — standalone bell / string terminator
const ESC = 0x1b; // ESC
const OSC_INTRO = 0x5d; // ]  — second byte of an OSC introducer (ESC ])
const ST_BS = 0x5c; // \  — second byte of the ESC \ string terminator
const SEMI = 0x3b; // ;

// String-introducer second bytes: DCS (ESC P), SOS (ESC X), PM (ESC ^),
// APC (ESC _). Their bodies are consumed to ST without emitting, so a BEL that
// terminates one is not miscounted as a standalone bell.
const DCS = 0x50; // P
const SOS = 0x58; // X
const PM = 0x5e; // ^
const APC = 0x5f; // _

/**
 * Maximum bytes buffered for one in-progress OSC before it is treated as
 * garbage and aborted (reset to IDLE). A real notification/status escape is at
 * most a few hundred bytes; 4 KiB is generous headroom and bounds the
 * partial-sequence window across chunk boundaries.
 */
const MAX_OSC_BYTES = 4 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One recognised attention/status signal. Shape-compatible with the wire
 * {@link PaneNotifyMessage} minus the transport fields (type/seq/paneId).
 */
export interface PaneNotifyDetection {
  readonly kind: PaneNotifyKind;
  /** Kind-scoped payload; absent for `bell`. */
  readonly payload?: PaneNotifyPayload;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type State =
  | "IDLE" // normal bytes
  | "ESC" // saw 0x1B — may introduce OSC / a string / a CSI/simple escape
  | "OSC" // inside ESC ] <content> — accumulating into _buf
  | "OSC_ESC" // saw ESC inside an OSC — may be ESC \ (ST)
  | "STR" // inside a DCS/APC/PM/SOS string — consume to ST, no emit
  | "STR_ESC"; // saw ESC inside a string — may be ESC \ (ST)

/**
 * Per-pane streaming attention/status scanner.
 *
 * Instantiate one per pane. Feed decoded raw pty bytes (the same bytes that go
 * to the demux) through {@link scan}. The returned detections are surfaced as
 * `pane.notify` events; the input bytes are NOT modified.
 *
 * NOT re-entrant: call `scan()` sequentially, never in parallel.
 */
export class PaneNotifyScanner {
  private _state: State = "IDLE";

  /** Accumulates the current OSC's content bytes (everything after `ESC ]`). */
  private _buf = new Uint8Array(128);
  private _bufLen = 0;

  /** Length of the current DCS/APC/PM/SOS string body (bound check only). */
  private _strLen = 0;

  /**
   * Feed a chunk of decoded pty bytes. Returns every signal recognised in this
   * chunk (possibly completing a sequence begun in a prior chunk). Does NOT
   * modify `chunk`.
   */
  scan(chunk: Uint8Array): PaneNotifyDetection[] {
    // Fast path: nothing in progress and no byte that can start/terminate a
    // sequence — no work, no allocation.
    if (this._state === "IDLE" && !hasEscOrBel(chunk)) {
      return EMPTY;
    }

    const out: PaneNotifyDetection[] = [];

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;

      switch (this._state) {
        case "IDLE": {
          if (b === BEL) {
            out.push(BELL_DETECTION);
          } else if (b === ESC) {
            this._state = "ESC";
          }
          break;
        }

        case "ESC": {
          if (b === OSC_INTRO) {
            this._state = "OSC";
            this._bufLen = 0;
          } else if (b === DCS || b === SOS || b === PM || b === APC) {
            this._state = "STR";
            this._strLen = 0;
          } else if (b === ESC) {
            // ESC ESC — stay armed for the next introducer.
          } else {
            // Simple escape or CSI introducer (ESC [ …). We don't track these:
            // none carry a BEL/ST, so a later BEL is a genuine bell.
            this._state = "IDLE";
          }
          break;
        }

        case "OSC": {
          if (b === BEL) {
            const d = this._finishOsc();
            if (d !== null) out.push(d);
          } else if (b === ESC) {
            this._state = "OSC_ESC";
          } else {
            if (!this._pushOscByte(b)) {
              // Overflow: garbage — abort this OSC and re-process b from IDLE.
              this._state = "IDLE";
              i--;
            }
          }
          break;
        }

        case "OSC_ESC": {
          if (b === ST_BS) {
            const d = this._finishOsc();
            if (d !== null) out.push(d);
          } else {
            // ESC not followed by \ aborts the OSC. Re-process b from IDLE
            // (it may itself be ESC / BEL / an OSC intro).
            this._state = "IDLE";
            this._bufLen = 0;
            i--;
          }
          break;
        }

        case "STR": {
          if (b === BEL) {
            this._state = "IDLE"; // ST — string done, nothing to emit
          } else if (b === ESC) {
            this._state = "STR_ESC";
          } else if (++this._strLen > MAX_OSC_BYTES) {
            this._state = "IDLE"; // over-long string — abort
          }
          break;
        }

        case "STR_ESC": {
          if (b === ST_BS) {
            this._state = "IDLE"; // ESC \ ST — string done
          } else {
            this._state = "IDLE";
            i--; // re-process b from IDLE
          }
          break;
        }
      }
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Append one OSC content byte; returns false on overflow. */
  private _pushOscByte(b: number): boolean {
    if (this._bufLen >= MAX_OSC_BYTES) return false;
    if (this._bufLen >= this._buf.length) {
      const next = new Uint8Array(Math.min(this._buf.length * 2, MAX_OSC_BYTES));
      next.set(this._buf);
      this._buf = next;
    }
    this._buf[this._bufLen++] = b;
    return true;
  }

  /**
   * A terminator arrived: parse the accumulated OSC content, reset to IDLE, and
   * return a detection (or null for an OSC we recognise structurally but do not
   * surface, e.g. OSC 0/2 titles or OSC 1337).
   */
  private _finishOsc(): PaneNotifyDetection | null {
    const content = decodeUtf8(this._buf, this._bufLen);
    this._state = "IDLE";
    this._bufLen = 0;
    return parseOscContent(content);
  }
}

// ---------------------------------------------------------------------------
// OSC content parsing (pure)
// ---------------------------------------------------------------------------

/** The `bell` detection is a constant — it carries no payload. */
const BELL_DETECTION: PaneNotifyDetection = { kind: "bell" };

const EMPTY: PaneNotifyDetection[] = [];

/**
 * Parse an OSC's content (everything between `ESC ]` and the terminator) into a
 * detection, or null when it is not an attention/status signal we surface.
 */
export function parseOscContent(content: string): PaneNotifyDetection | null {
  const semi = content.indexOf(";");
  const param = semi === -1 ? content : content.slice(0, semi);
  const rest = semi === -1 ? "" : content.slice(semi + 1);

  switch (param) {
    case "9":
      return parseOsc9(rest);
    case "777":
      return parseOsc777(rest);
    case "633":
      return parseOsc633(rest);
    default:
      // OSC 0/2 (titles, handled elsewhere), 1337 (recognised but not surfaced),
      // and every other number: no attention signal.
      return null;
  }
}

/**
 * OSC 9. Two overloaded forms:
 *   - ConEmu progress: `9 ; 4 ; <st> ; <pr>` (st is a single digit 0–4).
 *   - Desktop notification: `9 ; <body>` (iTerm2 / Claude Code / generic).
 * The `4;<digit>` prefix disambiguates to progress; everything else is a
 * notification whose body is the entire remainder (which may contain `;`).
 */
function parseOsc9(rest: string): PaneNotifyDetection | null {
  if (rest.length >= 3 && rest[0] === "4" && rest[1] === ";") {
    const st = rest.charCodeAt(2);
    if (st >= 0x30 && st <= 0x34) {
      return parseConEmuProgress(rest.slice(2));
    }
  }
  // Desktop notification: the body is the full remainder.
  return { kind: "osc9", payload: { message: rest, source: "osc9" } };
}

/** ConEmu progress args after the `4;` prefix: `<st> ; <pr>`. */
function parseConEmuProgress(args: string): PaneNotifyDetection {
  const parts = args.split(";");
  const state = CONEMU_STATE[parts[0] ?? ""];
  const payload: { progressState?: PaneProgressState; progress?: number } = {};
  if (state !== undefined) payload.progressState = state;
  // A percentage is meaningful for set/error/paused; parse when present.
  if (parts.length >= 2 && (state === "set" || state === "error" || state === "paused")) {
    const pr = parseInt(parts[1]!, 10);
    if (Number.isFinite(pr)) payload.progress = clampPercent(pr);
  }
  return { kind: "progress", payload };
}

const CONEMU_STATE: Record<string, PaneProgressState> = {
  "0": "remove",
  "1": "set",
  "2": "error",
  "3": "indeterminate",
  "4": "paused",
};

/**
 * OSC 777 (urxvt/tmux notify): `notify ; <title> ; <body>`. Only the `notify`
 * sub-command is a signal; `<body>` may itself contain `;`.
 */
function parseOsc777(rest: string): PaneNotifyDetection | null {
  const parts = rest.split(";");
  if (parts[0] !== "notify") return null;
  const title = parts[1] ?? "";
  const message = parts.length > 2 ? parts.slice(2).join(";") : "";
  const payload: PaneNotifyPayload = { message, source: "osc777" };
  return {
    kind: "osc9",
    payload: title.length > 0 ? { ...payload, title } : payload,
  };
}

/**
 * OSC 633 (VS Code shell integration). Only the `D` (command-finished)
 * sub-command carries an exit signal: `D ; <exitcode>`. The exit code is absent
 * when the shell could not determine it.
 */
function parseOsc633(rest: string): PaneNotifyDetection | null {
  const parts = rest.split(";");
  if (parts[0] !== "D") return null;
  if (parts.length >= 2 && parts[1] !== "") {
    const code = parseInt(parts[1]!, 10);
    if (Number.isFinite(code)) return { kind: "cmd-exit", payload: { exitCode: code } };
  }
  // Command finished, exit code unknown.
  return { kind: "cmd-exit" };
}

function clampPercent(n: number): number {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.trunc(n);
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

/** True when the chunk contains an ESC (0x1B) or BEL (0x07) — the fast-path gate. */
function hasEscOrBel(chunk: Uint8Array): boolean {
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i]!;
    if (b === ESC || b === BEL) return true;
  }
  return false;
}

/** Decode `buf[0..len]` as UTF-8, falling back to Latin-1 (never throws). */
function decodeUtf8(buf: Uint8Array, len: number): string {
  if (len === 0) return "";
  const slice = buf.subarray(0, len);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    return new TextDecoder("latin1").decode(slice);
  }
}
