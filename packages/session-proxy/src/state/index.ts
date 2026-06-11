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

// Reducer types (tc-j9c.2: SwitchClientOutcome for switch-client narrowing)
export type { ReducerContext, PaneBufferStore as ReducerPaneBufferStore, SwitchClientOutcome } from "./reducer.js";
export { reduce } from "./reducer.js";

// tc-835: attach-time bootstrap → live-delta handoff
export {
  BOOTSTRAP_WINDOWS_FORMAT,
  BOOTSTRAP_PANES_FORMAT,
  bootstrapCommands,
  parseWindowsReply,
  parsePanesReply,
  buildInitialModel,
  BootstrapCoordinator,
} from "./bootstrap.js";
export type {
  WindowsReplyRow,
  PanesReplyRow,
  BootstrapCoordinatorOptions,
  BootstrapPhase,
} from "./bootstrap.js";

// tc-128.1: requery engine + diff-to-deltas
export { requeryDiff, createRequeryEngine } from "./requery.js";
export type {
  RequeryResult,
  RequeryEngine,
  RequeryEngineOptions,
  SubmitCommand,
} from "./requery.js";
