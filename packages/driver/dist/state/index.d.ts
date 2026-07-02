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
export type { Pane, Window, Session, FocusState, SessionModel, ScrollbackHandle, InvariantViolation, CheckInvariantsOptions, PaneMode, WindowLayout, } from "./model.js";
export { paneId, windowId, sessionId, scrollbackHandle, checkInvariants, emptyModel, addSession, removeSession, updateSession, addWindow, removeWindow, updateWindow, addPane, removePane, updatePane, setFocus, parsedLayoutToWindowLayout, } from "./model.js";
export type { PaneBufferStore } from "./scrollback.js";
export { createPaneBufferStore, DEFAULT_CAP_BYTES } from "./scrollback.js";
export type { SwitchClientOutcome } from "./switch-client.js";
export { BOOTSTRAP_WINDOWS_FORMAT, BOOTSTRAP_PANES_FORMAT, TMUXCC_LABEL_OPTION, bootstrapCommands, parseWindowsReply, parsePanesReply, buildInitialModel, } from "./bootstrap.js";
export type { WindowsReplyRow, PanesReplyRow, SessionTarget, } from "./bootstrap.js";
export { requeryDiff, createRequeryEngine } from "./requery.js";
export type { RequeryResult, RequeryEngine, RequeryEngineOptions, SubmitCommand, } from "./requery.js";
export { createCoalescer, realClock, isTopologyEvent } from "./coalescer.js";
export type { Coalescer, CoalescerOptions, Clock, TimeoutHandle, TopologyEventKind, } from "./coalescer.js";
//# sourceMappingURL=index.d.ts.map