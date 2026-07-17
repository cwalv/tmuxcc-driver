/**
 * Per-window client-size reporter (tc-cvny).
 *
 * The driver's single tmux `-CC` client reports each window's viewport to tmux
 * via `refresh-client -C @<win>:WxH` (tmux >= 3.4). tmux stores the size
 * per-(client, window) and folds it into its own `latest`/`largest`/`smallest`
 * arbitration (resize.c:175-244) — this is a truthful, finer-grained report into
 * the arbitration tmux already runs, NOT a mode and NOT a policy layer. The
 * driver holds no sizing policy; this ledger is a cache of our OWN last-reported
 * sizes so we can change-gate (skip a report tmux already has, iTerm2's
 * "It's already that size. Do nothing." — TmuxController.m:1019-1054).
 *
 * # Report every window, never clear while attached
 *
 * Two pinned tmux semantics (tc-cvny.1) shape the policy:
 *
 *   - Participation is sticky and the fallback is the driver's GLOBAL tty size.
 *     A control client is ignored for sizing until its first `refresh-client -C`
 *     ever; thereafter any window WITHOUT a `@w` entry contributes the driver's
 *     arbitrary global pty size on every recalc (live-proven: the first report
 *     snapped every unreported window to 80x24). So once we report ANY window we
 *     must report EVERY window we know — never-revealed windows included, at
 *     their creator-inherited/current dims — or the ones we skip get corrupted.
 *   - Clearing a report (`refresh-client -C @w:`) means "adopt my global size",
 *     NOT "revert to the previous size". So we NEVER clear a report while
 *     attached; unbinding a window simply stops updating its report (stale is
 *     soft — tmux frees the per-window entry itself on client loss). We do drop
 *     a window's ledger entry when the window LEAVES the model (it is gone;
 *     tmux already cleaned up), which is bookkeeping, not a wire clear.
 *
 * # Two report triggers
 *
 *   - {@link SizeReporter.reportForPane} — the extension's explicit box report
 *     for a rendered window (the `resize.request` wire path). Resolves the
 *     pane's window and reports that window's box. The FIRST such call begins
 *     participation and, in the same batch, reports every other known window at
 *     its current dims so nothing snaps.
 *   - {@link SizeReporter.onModelChange} — once participating, reports any window
 *     that has appeared without a report yet (a never-revealed window created
 *     after participation began) at its current dims, and prunes ledger entries
 *     for windows that have left the model.
 *
 * Reports are batched through `sendBatch` so a burst is one host write; the
 * transient mid-burst snap of not-yet-reached windows costs only notification
 * chatter (tmux re-tiles synchronously per `refresh-client -C`, tc-cvny.1) and
 * the final state is correct.
 *
 * @module runtime/size-report
 */

import type { PaneId, WindowId } from "@tmuxcc/protocol";
import type { SessionModel, Window } from "../state/model.js";
import { refreshClientWindowSize } from "../parser/commands.js";
import { defaultPaneIdToTmux, defaultWindowIdToTmux } from "./input-path.js";

/** A reported viewport size for one window. */
interface WindowSize {
  readonly cols: number;
  readonly rows: number;
}

/** Options for {@link createSizeReporter}. */
export interface SizeReporterOptions {
  /** Current session model (pane→window resolution + per-window current dims). */
  readonly getModel: () => SessionModel;
  /**
   * Fire-and-forget batch write. Every report burst goes out as one call so
   * tmux processes it as a single read (bounds the mid-burst transient).
   */
  readonly sendBatch: (cmds: readonly string[]) => void;
  /** PaneId→tmux-numeric override (defaults to the `p<N>` convention). */
  readonly paneIdToTmux?: (id: PaneId) => number;
  /** WindowId→tmux-numeric override (defaults to the `w<N>` convention). */
  readonly windowIdToTmux?: (id: WindowId) => number;
}

/** Per-session per-window size reporter. One instance per session-proxy. */
export interface SizeReporter {
  /**
   * Report the box of the window that owns `paneId`, change-gated. Begins
   * participation on the first call (and, in the same batch, reports every other
   * known window at its current dims). A `paneId` whose pane/window is not in the
   * model is dropped (a resize for a vanished pane is moot).
   */
  reportForPane(paneId: PaneId, cols: number, rows: number): void;

  /**
   * React to a model change: once participating, report any newly-appeared
   * window that has no report yet (never-revealed windows keep their current
   * dims) and prune ledger entries for windows that have left the model.
   */
  onModelChange(): void;

  /**
   * The size last reported for the tmux window numbered `windowTmuxNum`, or
   * `undefined` if we have never reported it. Used by the hydration pre-capture
   * gate to re-issue a target window's report before a different-size reattach.
   */
  reportedSizeForWindow(windowTmuxNum: number): WindowSize | undefined;
}

/** Build a {@link SizeReporter}. See the module docstring for the semantics. */
export function createSizeReporter(opts: SizeReporterOptions): SizeReporter {
  const getModel = opts.getModel;
  const sendBatch = opts.sendBatch;
  const toTmuxPane = opts.paneIdToTmux ?? defaultPaneIdToTmux;
  const toTmuxWindow = opts.windowIdToTmux ?? defaultWindowIdToTmux;

  /** Our last-reported size per tmux window number. `.has()` = reported at least once. */
  const ledger = new Map<number, WindowSize>();
  /**
   * True once we have issued (or are issuing) our first report. Before this the
   * driver is ignored for sizing entirely, so onModelChange must NOT start
   * participating on its own — only an explicit box report (reportForPane) does.
   */
  let participating = false;

  /** Current dims of a window from its layout, or `undefined` if not known yet. */
  function currentDims(win: Window): WindowSize | undefined {
    const layout = win.layout;
    if (layout === null) return undefined;
    return { cols: layout.cols, rows: layout.rows };
  }

  /**
   * Recompute reports for every window and flush the change-gated batch.
   * `override`, when present, forces one window's reported size (the box a
   * `resize.request` just declared); every other unreported window falls back to
   * its current dims. Windows already in the ledger keep their reported size
   * (sync never re-reports them — no oscillation with the extension's own
   * reports). Ledger entries for windows no longer in the model are pruned.
   */
  function flush(override?: { readonly winNum: number; readonly size: WindowSize }): void {
    const model = getModel();
    const cmds: string[] = [];
    const live = new Set<number>();
    for (const [winId, win] of model.windows) {
      const winNum = toTmuxWindow(winId);
      live.add(winNum);
      let desired: WindowSize | undefined;
      if (override !== undefined && override.winNum === winNum) {
        desired = override.size;
      } else if (ledger.has(winNum)) {
        continue; // already reported; leave it (only reportForPane changes a report)
      } else {
        desired = currentDims(win);
        if (desired === undefined) continue; // layout unknown yet — catch it next model change
      }
      const prev = ledger.get(winNum);
      if (prev !== undefined && prev.cols === desired.cols && prev.rows === desired.rows) {
        continue; // change-gate: tmux already has this size
      }
      ledger.set(winNum, desired);
      cmds.push(refreshClientWindowSize(winNum, desired.cols, desired.rows));
    }
    for (const winNum of Array.from(ledger.keys())) {
      if (!live.has(winNum)) ledger.delete(winNum);
    }
    if (cmds.length > 0) sendBatch(cmds);
  }

  return {
    reportForPane(paneId, cols, rows): void {
      const model = getModel();
      const pane = model.panes.get(paneId);
      if (pane === undefined) return; // stale resize for a vanished pane
      if (!model.windows.has(pane.windowId)) return;
      participating = true;
      flush({ winNum: toTmuxWindow(pane.windowId), size: { cols, rows } });
    },

    onModelChange(): void {
      if (!participating) return;
      flush();
    },

    reportedSizeForWindow(windowTmuxNum): WindowSize | undefined {
      return ledger.get(windowTmuxNum);
    },
  };
}
