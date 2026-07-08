/**
 * State module — canonical in-session-proxy session model.
 *
 * Public surface:
 *   - Model types: SessionModel, Session, Window, Pane, PaneOverlay, FocusState
 *   - Id types (re-exported from wire): PaneId, WindowId, SessionId
 *   - Id constructors: paneId(), windowId(), sessionId()
 *   - PaneMode (re-exported from wire)
 *   - WindowLayout (re-exported from wire)
 *   - emptyPaneOverlay() → PaneOverlay
 *   - InvariantViolation — structured violation type for checkInvariants
 *   - checkInvariants(model, opts?) → InvariantViolation[]
 *   - emptyModel() → SessionModel
 *   - addSession / removeSession / updateSession
 *   - addWindow  / removeWindow  / updateWindow
 *   - addPane    / removePane    / updatePane / updatePaneOverlay
 *   - setFocus
 *   - parsedLayoutToWindowLayout — bridge ParsedLayout → WindowLayout
 */

export type {
  Pane,
  PaneOverlay,
  Window,
  Session,
  FocusState,
  SessionModel,
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
  // Overlay constructor
  emptyPaneOverlay,
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
  updatePaneOverlay,
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

// tc-835: bootstrap reply schema/codec + initial-model builder. The
// `BootstrapCoordinator` (per-event reducer driver) was retired in tc-128.4;
// the requery engine now owns the bootstrap path end-to-end. tc-mysc: the two
// reply-row SCHEMAS derive their format string, strict parser, and fixtures.
export {
  WINDOWS_ROW,
  PANES_ROW,
  BOOTSTRAP_WINDOWS_FORMAT,
  BOOTSTRAP_PANES_FORMAT,
  TMUXCC_LABEL_OPTION,
  bootstrapCommands,
  buildInitialModel,
} from "./bootstrap.js";
export type {
  WindowsReplyRow,
  PanesReplyRow,
  SessionTarget,
} from "./bootstrap.js";

// tc-mysc: generic reply-row codec + its fail-loud error hierarchy.
export {
  defineReplyRow,
  ReplyCodecError,
  ReplyShapeError,
  FieldDecodeError,
} from "./reply-row.js";
export type { ReplyRow, RowOf, FieldCodec, FieldSpec } from "./reply-row.js";

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
