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
export { 
// Id constructors
paneId, windowId, sessionId, scrollbackHandle, 
// Invariant checker
checkInvariants, 
// Constructors
emptyModel, 
// Session helpers
addSession, removeSession, updateSession, 
// Window helpers
addWindow, removeWindow, updateWindow, 
// Pane helpers
addPane, removePane, updatePane, 
// Focus helper
setFocus, 
// Parser→model bridge
parsedLayoutToWindowLayout, } from "./model.js";
export { createPaneBufferStore, DEFAULT_CAP_BYTES } from "./scrollback.js";
// tc-835: bootstrap reply parsing + initial-model builder. The
// `BootstrapCoordinator` (per-event reducer driver) was retired in tc-128.4;
// the requery engine now owns the bootstrap path end-to-end.
export { BOOTSTRAP_WINDOWS_FORMAT, BOOTSTRAP_PANES_FORMAT, TMUXCC_LABEL_OPTION, bootstrapCommands, parseWindowsReply, parsePanesReply, buildInitialModel, } from "./bootstrap.js";
// tc-128.1: requery engine + diff-to-deltas
export { requeryDiff, createRequeryEngine } from "./requery.js";
// tc-128.2: dirty-bit coalescer (leading edge, 1 Hz ceiling, heartbeat)
export { createCoalescer, realClock, isTopologyEvent } from "./coalescer.js";
//# sourceMappingURL=index.js.map