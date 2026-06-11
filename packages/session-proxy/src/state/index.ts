/**
 * State module — canonical in-session-proxy session model.
 *
 * Public surface:
 *   - Model types: SessionModel, Session, Window, Pane, FocusState
 *   - Id types (re-exported from wire): PaneId, WindowId, SessionId
 *   - Id constructors: paneId(), windowId(), sessionId(), scrollbackHandle()
 *   - PaneMode (re-exported from wire)
 *   - WindowLayout (re-exported from wire)
 *   - ScrollbackHandle — opaque handle for tc-fx2's ring-buffer store
 *   - InvariantViolation — structured violation type for checkInvariants
 *   - checkInvariants(model, opts?) → InvariantViolation[]
 *   - emptyModel() → SessionModel
 *   - addSession / removeSession / updateSession
 *   - addWindow  / removeWindow  / updateWindow
 *   - addPane    / removePane    / updatePane
 *   - setFocus
 *   - parsedLayoutToWindowLayout — bridge ParsedLayout → WindowLayout
 */

export type {
  Pane,
  Window,
  Session,
  FocusState,
  SessionModel,
  ScrollbackHandle,
  InvariantViolation,
  CheckInvariantsOptions,
  PaneMode,
  WindowLayout,
} from "./model.js";

export {
  // Id constructors
  paneId,
  windowId,
  sessionId,
  scrollbackHandle,
  // Invariant checker
  checkInvariants,
  // Constructors
  emptyModel,
  // Session helpers
  addSession,
  removeSession,
  updateSession,
  // Window helpers
  addWindow,
  removeWindow,
  updateWindow,
  // Pane helpers
  addPane,
  removePane,
  updatePane,
  // Focus helper
  setFocus,
  // Parser→model bridge
  parsedLayoutToWindowLayout,
} from "./model.js";

// tc-fx2: per-pane scrollback ring buffer
export type { PaneBufferStore } from "./scrollback.js";
export { createPaneBufferStore, DEFAULT_CAP_BYTES } from "./scrollback.js";

// tc-j9c.2: SwitchClientOutcome — retained as a wire-level type used by the
// session-proxy runtime to react to switch-client drift detected from
// requery-driven model deltas (the per-event reducer that originally owned
// this type was retired in tc-128.4).
export type { SwitchClientOutcome } from "./switch-client.js";

// tc-835: bootstrap reply parsing + initial-model builder. The
// `BootstrapCoordinator` (per-event reducer driver) was retired in tc-128.4;
// the requery engine now owns the bootstrap path end-to-end.
export {
  BOOTSTRAP_WINDOWS_FORMAT,
  BOOTSTRAP_PANES_FORMAT,
  bootstrapCommands,
  parseWindowsReply,
  parsePanesReply,
  buildInitialModel,
} from "./bootstrap.js";
export type {
  WindowsReplyRow,
  PanesReplyRow,
} from "./bootstrap.js";

// tc-128.1: requery engine + diff-to-deltas
export { requeryDiff, createRequeryEngine } from "./requery.js";
export type {
  RequeryResult,
  RequeryEngine,
  RequeryEngineOptions,
  SubmitCommand,
} from "./requery.js";

// tc-128.2: dirty-bit coalescer (leading edge, 1 Hz ceiling, heartbeat)
export { createCoalescer, realClock, isTopologyEvent } from "./coalescer.js";
export type {
  Coalescer,
  CoalescerOptions,
  Clock,
  TimeoutHandle,
  TopologyEventKind,
} from "./coalescer.js";
