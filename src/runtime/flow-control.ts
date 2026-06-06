/**
 * Flow-control coordinator — high/low-water backpressure + honor
 * %pause/%continue via refresh-client -A (tc-1ho).
 *
 * # Problem
 *
 * A firehose pane (e.g. `yes`) can emit bytes faster than the client can
 * consume them.  Without backpressure the daemon buffers unboundedly and the
 * client's receive queue grows without bound.
 *
 * tmux's control-mode provides flow control via `refresh-client -A`:
 *   - `%<pane>:pause`    — ask tmux to stop sending %output for that pane
 *   - `%<pane>:continue` — ask tmux to resume
 *
 * tmux acknowledges with a `%pause %<pane>` / `%continue %<pane>` notification
 * when the pause/resume has taken effect on the tmux side.
 *
 * # Design
 *
 * ## Two sources of pause/resume
 *
 * 1. **Backpressure (high/low-water)**: the daemon's own byte accounting.
 *    Each time `onPaneBytes(paneId, n)` is called (by whoever appends to the
 *    demux store), buffered bytes are incremented.  When a pane crosses the
 *    HIGH-WATER mark the controller:
 *      a. Sends `refresh-client -A '%<tmuxN>:pause'` to tmux via `host.write`.
 *      b. Calls `demux.pausePane(paneId)` to gate fan-out immediately, before
 *         tmux's `%pause` notification arrives (eliminates the notification
 *         round-trip from the gate path).
 *
 *    When the caller notifies that bytes have been drained (`noteDrained(id, n)`)
 *    and the counter falls below the LOW-WATER mark, the controller:
 *      a. Sends `refresh-client -A '%<tmuxN>:continue'` to tmux.
 *      b. Calls `demux.resumePane(paneId)` to open the fan-out gate.
 *
 * 2. **Honor tmux's unsolicited %pause/%continue**: tmux may also send these
 *    notifications on its own (e.g. capacity management across multiple clients).
 *    `onPauseNotification(paneId)` and `onContinueNotification(paneId)` handle
 *    those by updating the demux gate accordingly.
 *
 * ## Water-mark policy and defaults
 *
 *   HIGH_WATER_DEFAULT = 256 KiB (262 144 bytes)
 *   LOW_WATER_DEFAULT  =  64 KiB ( 65 536 bytes)
 *
 * Rationale:
 *   - 256 KiB is large enough to absorb burst output without false pausing
 *     under normal workloads (a `yes` at full speed emits ~100 MB/s; 256 KiB
 *     gives ~2.5 ms of headroom — plenty for a drain cycle).
 *   - 64 KiB hysteresis gap prevents rapid pause/resume oscillation (chattering)
 *     when the pane output rate is close to the client drain rate.
 *   - Both values are configurable via opts.
 *
 * ## No bytes are dropped
 *
 *   - Pausing stops NEW output at the source (tmux), not at the buffer level.
 *   - Bytes already written to the demux store before the pause command reaches
 *     tmux are still delivered; the demux gate only prevents further fan-out
 *     while paused.
 *   - `noteDrained` removes bytes from the logical counter without touching the
 *     scrollback store — the store is append-only (tc-fx2's concern).
 *
 * ## API seam for tc-93a (integration test)
 *
 *   tc-93a drives a flood via the pipeline's notification path:
 *     1. Call `fc.onPaneBytes(paneId, byteCount)` for each append.
 *     2. Observe `host.write()` calls for pause/continue commands.
 *     3. Call `fc.noteDrained(paneId, byteCount)` to simulate client drain.
 *     4. Observe resume command + demux gate state.
 *
 *   Alternatively tc-93a can subscribe to pipeline notifications and call the
 *   notification helpers directly.
 *
 * ## Testability
 *
 *   The controller works with any object that satisfies the TmuxHost interface
 *   (use a simple fake that records `write()` calls) and any OutputDemux (use
 *   a real `createOutputDemux()` with fake transports).  No real tmux needed.
 *
 * @module runtime/flow-control
 */

import type { TmuxHost } from "./tmux-host.js";
import type { OutputDemux } from "./output-demux.js";
import type { PaneId } from "../wire/ids.js";
import { refreshClientFlow } from "../parser/commands.js";
import { defaultPaneIdToTmux } from "./input-path.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default high-water mark in bytes (256 KiB). Pause triggered above this. */
export const DEFAULT_HIGH_WATER_BYTES = 262_144; // 256 KiB

/** Default low-water mark in bytes (64 KiB). Resume triggered below this. */
export const DEFAULT_LOW_WATER_BYTES = 65_536; // 64 KiB

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for `createFlowController`. */
export interface FlowControllerOptions {
  /**
   * High-water mark in bytes per pane.
   * When buffered bytes exceed this value the controller pauses the pane.
   * Default: 262_144 (256 KiB).
   */
  highWaterBytes?: number;

  /**
   * Low-water mark in bytes per pane.
   * When buffered bytes fall below this value after a pause the controller
   * resumes the pane.  Must be < highWaterBytes.
   * Default: 65_536 (64 KiB).
   */
  lowWaterBytes?: number;

  /**
   * Override the default PaneId → tmux numeric ID mapping.
   * Default strips the "p" prefix and parses the decimal integer.
   * Supply a registry-backed function for multi-session namespacing.
   */
  paneIdToTmux?: (id: PaneId) => number;
}

/**
 * FlowController — coordinates per-pane pause/resume between the demux gate
 * and the upstream tmux refresh-client -A command.
 *
 * Obtain via `createFlowController(host, demux, opts?)`.
 */
export interface FlowController {
  /**
   * Record that `byteCount` bytes have been appended for `paneId`.
   *
   * Called by the caller each time bytes are appended to the demux store
   * (i.e. wrap around the append tap or call from the pipeline layer).
   * When the cumulative total crosses the high-water mark the controller
   * issues a pause command and gates the demux.
   */
  onPaneBytes(paneId: PaneId, byteCount: number): void;

  /**
   * Record that `byteCount` bytes have been drained (acknowledged by the
   * client or freed from the send queue) for `paneId`.
   *
   * When the remaining buffered total falls below the low-water mark while
   * the pane is paused, the controller issues a continue command and opens
   * the demux gate.
   */
  noteDrained(paneId: PaneId, byteCount: number): void;

  /**
   * Honor an incoming `%pause %<pane>` notification from tmux.
   *
   * Gates the demux fan-out for the pane (idempotent if already paused by
   * backpressure logic).  The `paneId` is the wire-format branded id ("p<N>").
   */
  onPauseNotification(paneId: PaneId): void;

  /**
   * Honor an incoming `%continue %<pane>` notification from tmux.
   *
   * Opens the demux fan-out gate for the pane (idempotent if already resumed).
   */
  onContinueNotification(paneId: PaneId): void;

  /**
   * Handle an incoming `%extended-output` notification.
   *
   * `%extended-output` carries an age/staleness field for output produced
   * while tmux was paused.  This controller does not act on the age field
   * but must not choke on the notification.  The byte count is forwarded
   * to `onPaneBytes` so backpressure accounting stays accurate.
   *
   * @param paneId     Wire-format pane id.
   * @param byteCount  Byte length of the extended-output payload.
   */
  onExtendedOutput(paneId: PaneId, byteCount: number): void;

  /**
   * Whether a pane is currently paused by the flow controller.
   * Mirrors `demux.isPanePaused(paneId)` — provided for diagnostic convenience.
   */
  isPanePaused(paneId: PaneId): boolean;

  /**
   * Current buffered byte count for a pane.
   * Reflects `onPaneBytes` minus `noteDrained` calls.  For diagnostics/tests.
   */
  bufferedBytes(paneId: PaneId): number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class FlowControllerImpl implements FlowController {
  private readonly _host: TmuxHost;
  private readonly _demux: OutputDemux;
  private readonly _highWater: number;
  private readonly _lowWater: number;
  private readonly _toTmux: (id: PaneId) => number;

  /** Per-pane buffered byte counter. */
  private readonly _buffered = new Map<PaneId, number>();

  /** Tracks which panes are currently paused (by any source). */
  private readonly _paused = new Set<PaneId>();

  constructor(host: TmuxHost, demux: OutputDemux, opts: FlowControllerOptions = {}) {
    this._host = host;
    this._demux = demux;
    this._highWater = opts.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
    this._lowWater = opts.lowWaterBytes ?? DEFAULT_LOW_WATER_BYTES;
    this._toTmux = opts.paneIdToTmux ?? defaultPaneIdToTmux;

    if (this._lowWater >= this._highWater) {
      throw new Error(
        `[flow-control] lowWaterBytes (${this._lowWater}) must be less than highWaterBytes (${this._highWater})`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  onPaneBytes(paneId: PaneId, byteCount: number): void {
    if (byteCount <= 0) return;
    const prev = this._buffered.get(paneId) ?? 0;
    const next = prev + byteCount;
    this._buffered.set(paneId, next);

    // Trigger pause if we just crossed the high-water mark (avoid re-pausing).
    if (!this._paused.has(paneId) && next > this._highWater) {
      this._pause(paneId);
    }
  }

  noteDrained(paneId: PaneId, byteCount: number): void {
    if (byteCount <= 0) return;
    const prev = this._buffered.get(paneId) ?? 0;
    const next = Math.max(0, prev - byteCount);
    this._buffered.set(paneId, next);

    // Trigger resume if we fell at or below low-water and the pane is
    // currently paused by backpressure (we only resume what we paused —
    // unsolicited tmux pauses are released via onContinueNotification).
    //
    // The original condition was `next < this._lowWater` (strict less-than),
    // but real-world drain credits often arrive in chunk-sized batches that
    // land EXACTLY on the low-water boundary (e.g. drained 192 KiB out of a
    // 256-KiB pause, the last credit lands at 64 KiB = low_water).  Strict
    // less-than would never trigger resume in that case, leaving the pane
    // paused forever under perfectly-aligned drains.  Hysteresis is still
    // preserved by the 192-KiB gap between high- and low-water defaults.
    if (this._paused.has(paneId) && next <= this._lowWater) {
      this._resume(paneId);
    }
  }

  onPauseNotification(paneId: PaneId): void {
    // tmux confirms the pane is paused. Ensure the demux gate is closed.
    if (!this._paused.has(paneId)) {
      this._paused.add(paneId);
      this._demux.pausePane(paneId);
    }
  }

  onContinueNotification(paneId: PaneId): void {
    // tmux confirms the pane has resumed. Open the demux gate.
    if (this._paused.has(paneId)) {
      this._paused.delete(paneId);
      this._demux.resumePane(paneId);
    }
  }

  onExtendedOutput(paneId: PaneId, byteCount: number): void {
    // %extended-output bytes still contribute to backpressure accounting.
    this.onPaneBytes(paneId, byteCount);
  }

  isPanePaused(paneId: PaneId): boolean {
    return this._demux.isPanePaused(paneId);
  }

  bufferedBytes(paneId: PaneId): number {
    return this._buffered.get(paneId) ?? 0;
  }

  // -------------------------------------------------------------------------
  // Internal: send pause/continue commands
  // -------------------------------------------------------------------------

  private _pause(paneId: PaneId): void {
    const tmuxN = this._toTmux(paneId);
    if (Number.isNaN(tmuxN)) {
      console.warn(`[flow-control] cannot map pane id "${paneId}" to tmux number — skipping pause`);
      return;
    }
    // Gate the demux fan-out immediately (before tmux acknowledges with %pause).
    this._paused.add(paneId);
    this._demux.pausePane(paneId);
    // Tell tmux to stop emitting %output for this pane.
    this._host.write(refreshClientFlow(tmuxN, "pause") + "\n");
  }

  private _resume(paneId: PaneId): void {
    const tmuxN = this._toTmux(paneId);
    if (Number.isNaN(tmuxN)) {
      console.warn(`[flow-control] cannot map pane id "${paneId}" to tmux number — skipping resume`);
      return;
    }
    // Open the demux gate.
    this._paused.delete(paneId);
    this._demux.resumePane(paneId);
    // Tell tmux to resume output for this pane.
    this._host.write(refreshClientFlow(tmuxN, "continue") + "\n");
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `FlowController` that coordinates per-pane pause/resume between
 * the demux client-side gate and the upstream tmux refresh-client -A command.
 *
 * # Wiring
 *
 * The controller must be notified about bytes entering and leaving the system:
 *
 * ```ts
 * const demux = createOutputDemux();
 * const fc = createFlowController(host, demux, {
 *   highWaterBytes: 262_144,
 *   lowWaterBytes:  65_536,
 * });
 *
 * // 1. Wrap the demux store's append to account bytes:
 * //    (or call fc.onPaneBytes from the pipeline notification handler)
 * const wrappedStore: PaneBufferStore = {
 *   ...demux.store,
 *   append(paneId, bytes) {
 *     demux.store.append(paneId, bytes);
 *     fc.onPaneBytes(paneId, bytes.length);
 *   },
 * };
 *
 * // 2. Wire the pipeline to the wrapped store:
 * const pipeline = createRuntimePipeline(host, { buffers: wrappedStore });
 *
 * // 3. Forward pause/continue notifications from the pipeline:
 * //    (subscribe to model changes or hook the correlator's onNotification)
 * //    fc.onPauseNotification(paneId)    — on %pause %<pane>
 * //    fc.onContinueNotification(paneId) — on %continue %<pane>
 * //    fc.onExtendedOutput(paneId, bytes.length) — on %extended-output
 *
 * // 4. Notify when client drains (e.g. from the serve layer after sendData):
 * //    fc.noteDrained(paneId, byteCount)
 * ```
 *
 * # Water-mark policy
 *
 *   HIGH_WATER = 256 KiB (default): pause requested when buffered > HIGH_WATER.
 *   LOW_WATER  =  64 KiB (default): resume requested when buffered < LOW_WATER
 *                                   (only after a pause).
 *   Hysteresis gap = 192 KiB — prevents rapid pause/resume oscillation.
 *
 * @param host  TmuxHost to write `refresh-client -A` commands to.
 * @param demux OutputDemux whose `pausePane`/`resumePane` gate client fan-out.
 * @param opts  Optional water-mark overrides and id-mapping override.
 */
export function createFlowController(
  host: TmuxHost,
  demux: OutputDemux,
  opts?: FlowControllerOptions,
): FlowController {
  return new FlowControllerImpl(host, demux, opts);
}
