/**
 * @tmuxcc/driver — public API.
 *
 * The driver is the Node-only tmux control-mode runtime: the per-socket
 * server-proxy (discovery + lifecycle) plus the per-session session-proxy
 * (parser → state → wire) that it hosts in-process.
 *
 * Wire types and framing live in @tmuxcc/protocol and are NOT re-exported here —
 * consumers import wire types from @tmuxcc/protocol directly and runtime from
 * @tmuxcc/driver.
 */
export declare const SESSION_PROXY_PLACEHOLDER = true;
/** Stub type: minimal session-proxy handle shape. */
export interface SessionProxyHandle {
    readonly pid: number;
    stop(): Promise<void>;
}
export type { SessionModel, Session, Window, Pane, FocusState, PaneMode, WindowLayout, ScrollbackHandle, InvariantViolation, CheckInvariantsOptions, } from "./state/index.js";
export { emptyModel, addSession, removeSession, updateSession, addWindow, removeWindow, updateWindow, addPane, removePane, updatePane, setFocus, checkInvariants, scrollbackHandle, } from "./state/index.js";
export { projectSnapshot, diffModel } from "./state/projection.js";
export type { ProjectSnapshotOpts, DiffOptions, OriginLookup, CloseCauseLookup } from "./state/projection.js";
export { paneBoundOptionName, TMUXCC_BOUND_OPTION } from "./state/bootstrap.js";
export { createVerbOriginRegistry } from "./runtime/verb-origin.js";
export type { VerbOriginRegistry, VerbOriginRegistryOptions, } from "./runtime/verb-origin.js";
export { createCloseCauseRegistry } from "./runtime/close-cause.js";
export type { CloseCauseRegistry, CloseCauseRegistryOptions, } from "./runtime/close-cause.js";
export { createSessionProxy } from "./runtime/session-proxy.js";
export type { SessionProxy, SessionProxyOptions, SessionProxyHostView, SessionProxyAddClientOptions } from "./runtime/session-proxy.js";
export { createTmuxHost } from "./runtime/tmux-host.js";
export type { TmuxHost, TmuxHostOptions } from "./runtime/tmux-host.js";
export { createOutputDemux, } from "./runtime/output-demux.js";
export type { OutputDemux, OutputDemuxOptions } from "./runtime/output-demux.js";
export { createFlowController, DEFAULT_HIGH_WATER_BYTES, DEFAULT_LOW_WATER_BYTES, } from "./runtime/flow-control.js";
export type { FlowController, FlowControllerOptions } from "./runtime/flow-control.js";
export type { CommandResult } from "./parser/correlator.js";
export { createControlServer } from "./runtime/serve.js";
export type { ControlServer, ControlServerOptions, } from "./runtime/serve.js";
export type { RuntimePipeline } from "./runtime/pipeline.js";
export { phaseLog, phaseNow, PHASE_TIMING_ENABLED } from "./runtime/phase-timing.js";
export type { PhaseFields } from "./runtime/phase-timing.js";
export { createSessionProxyRegistry, createStormAlarm } from "./metrics/index.js";
export type { SessionProxyRegistry, StormAlarm, StormAlarmOptions, KindBreakdown, } from "./metrics/index.js";
export { createServerProxy, ServerProxyAlreadyRunningError } from "./server-proxy.js";
export type { ServerProxyHandle, ServerProxyOptions, ServerProxySelfExitReason } from "./server-proxy.js";
export { createSocketTransport, connectSocketTransport, createSocketServer } from "./socket-transport.js";
export { serverProxySocketPath, serverProxyLogPath, edhTraceLogPath, resolveBaseRuntimeDir, gcStaleRuntimeDirs, probeLiveSocket, classifySocketOwner } from "./runtime-dir.js";
export { probeTmuxAlive, probeTmuxLiveness, type TmuxLiveness } from "./tmux-south.js";
//# sourceMappingURL=index.d.ts.map