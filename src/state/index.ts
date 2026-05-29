/**
 * State module — canonical in-daemon session model.
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
