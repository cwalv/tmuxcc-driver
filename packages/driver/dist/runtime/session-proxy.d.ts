/**
 * createSessionProxy — assemble the full session-proxy runtime from its component parts (tc-93a).
 *
 * This is the canonical "wire everything together" entry point for the E4
 * session-proxy runtime.  It mirrors what createClient() does on the client side:
 * hides the per-component wiring and exposes a single lifecycle handle.
 *
 * # Component graph
 *
 *   createTmuxHost       → TmuxHost       (spawns tmux -CC via PTY bridge)
 *   createOutputDemux    → OutputDemux    (taps PaneBufferStore → per-client fan-out)
 *   createRuntimePipeline→ RuntimePipeline(tmux stdout → model; uses demux.store)
 *   createControlServer  → ControlServer  (handshake + snapshot + delta stream)
 *   createInputPath      → InputPath      (client → tmux commands)
 *   createFlowController → FlowController (high/low-water backpressure)
 *
 * # Data flow
 *
 *   tmux stdout bytes
 *     → pipeline (tokenize → parse → bootstrap → reduce → model)
 *       → demux.store.append(paneId, bytes)  [tap]
 *           → per-client transport.sendData  [data plane]
 *           → fc.onPaneBytes                 [flow accounting]
 *     → server.onModelChange                 [control plane deltas]
 *
 *   client sendControl messages
 *     → transport.onControl → inputPath.handleClientMessage
 *         → pipeline.send (send-keys / refresh-client) → correlator → host.write
 *
 * # Wiring the flow-controller byte accounting
 *
 * The flow controller must be notified of every byte appended to the demux
 * store.  We wrap demux.store with a thin shim that calls fc.onPaneBytes
 * after each append.  The shim is built AFTER the FlowController is created
 * (to avoid a chicken-and-egg cycle) and passed to createRuntimePipeline as
 * `buffers`.
 *
 * @module runtime/session-proxy
 */
import type { TmuxHostOptions, ExitHandler, ErrorHandler } from "./tmux-host.js";
import type { OutputDemux } from "./output-demux.js";
import type { RuntimePipeline } from "./pipeline.js";
import type { ControlServer, ControlServerOptions, AddClientOptions } from "./serve.js";
import type { ClientFlags } from "@tmuxcc/protocol";
import type { InputPath, InputPathOptions } from "./input-path.js";
import type { FlowController, FlowControllerOptions } from "./flow-control.js";
import type { Transport } from "@tmuxcc/protocol";
import type { PaneId } from "@tmuxcc/protocol";
import type { SessionProxyRegistry, StormAlarmOptions } from "../metrics/index.js";
import type { CommandResult } from "../parser/correlator.js";
/**
 * Read/event-only view of the underlying TmuxHost exposed on SessionProxy.host.
 *
 * External consumers (e.g. server-proxy-entry, tmuxcc-vscode) may legitimately
 * need to observe host lifecycle events (onExit, onError) and read exit state
 * (exited).  They must NOT write raw commands to the host — use
 * `sessionProxy.send(command)` for all command sends so every write goes
 * through the pipeline's slotted, instrumented path (tc-3si.9).
 *
 * Members intentionally absent: `write`, `onData`, `onStderr`, `stop`, `kill`,
 * `start`, `pid`.  None of those are needed by legitimate external observers;
 * `stop`/`kill` are on SessionProxy directly, and `write` is replaced by
 * `sessionProxy.send`.
 */
export interface SessionProxyHostView {
    /**
     * Register a handler for process exit.
     * Returns an unsubscribe function.
     * If the process has already exited, the handler is called on the next tick.
     */
    onExit(handler: ExitHandler): () => void;
    /**
     * Register a handler for errors (spawn failure, stream errors).
     * Returns an unsubscribe function.
     */
    onError(handler: ErrorHandler): () => void;
    /**
     * True if the underlying tmux process has exited (or was never started).
     * False while running.
     */
    readonly exited: boolean;
}
/** Options for createSessionProxy. Each sub-group maps to the respective component. */
export interface SessionProxyOptions {
    /**
     * Options forwarded to createTmuxHost (socketName, sessionName, cols/rows, …).
     *
     * Required — socketName and sessionName inside must be provided explicitly.
     * There is no default socket; omitting it risks attaching to the user's
     * interactive tmux server.
     */
    host: TmuxHostOptions;
    /** Options forwarded to createControlServer (capabilities override). */
    server?: ControlServerOptions;
    /** Options forwarded to createInputPath (id-mapping overrides). */
    input?: InputPathOptions;
    /** Options forwarded to createFlowController (highWaterBytes / lowWaterBytes). */
    flow?: FlowControllerOptions;
    /**
     * Options for the topology-event storm alarm (tc-x6l).
     *
     * Omit to accept the defaults (2500 events / 5 s window, stderr alarm).
     * Pass `{ threshold: Infinity }` to disable the alarm while keeping counters.
     */
    stormAlarm?: StormAlarmOptions;
    /**
     * Called when the per-session pipeline catches an unhandled exception
     * (tc-2x3.4 per-session error boundary).
     *
     * Forwarded verbatim to `RuntimePipelineOptions.onFatalError`.  In the
     * collapsed single-process topology (tc-2x3.3), a throwing pipeline can
     * crash every session; this callback lets the caller (the server-proxy
     * supervisor) tear down and reattach ONLY the affected session while
     * leaving siblings running.
     *
     * When omitted, boundary trips are logged to stderr but the session is
     * NOT automatically recycled — backward-compat for test setups that do
     * not exercise the supervisor path.
     */
    onFatalError?: (err: unknown) => void;
    /**
     * Called once per topology-classified notification, BEFORE the coalescer's
     * policy runs.  Forwarded verbatim to `RuntimePipelineOptions.onTopologyNotify`.
     *
     * Production use: the server-proxy supervisor wires per-kind counters + the
     * storm alarm here.  Tests wire a THROWING hook here to exercise the
     * tc-2x3.4 error boundary: since this hook runs INSIDE `_dispatchEvent`,
     * which runs INSIDE the `host.onData` try/catch, a throw propagates into the
     * boundary rather than out of the event-loop callback.
     *
     * This is also the canonical fault-injection seam for tc-2x3.4's acceptance
     * test (EB1): inject via this hook, assert the boundary fires.
     */
    onTopologyNotify?: (kind: string) => void;
}
/**
 * Options for {@link SessionProxy.addClient}.
 *
 * `primaryPaneId` (tc-295a.8) selects the targeted-attach pane; the D5 fields
 * (`startSeq` / `preNegotiated`, tc-4b6k.4) carry the broker single-socket
 * handoff through to the control server; `flags` (D4, tc-4b6k.3) carries the
 * tmux-parity client flags from `session.attach`. All optional — the bare
 * in-memory path (`addClient(transport)`) runs the session-proxy handshake and
 * starts the seq at 1.
 */
export interface SessionProxyAddClientOptions extends AddClientOptions {
    /** Broker-forwarded targeted-attach pane (tc-295a.8). */
    primaryPaneId?: PaneId;
    /**
     * D4 (tc-4b6k.3): tmux-parity flags from `session.attach`.
     * `ignoreSize: true` → drop this client's `resize.request` (don't issue
     * `refresh-client -C`).
     * `readOnly: true` → drop `input` messages and reject mutating
     * `command.request` verbs (driver-enforced; tmux `-CC` ignores the flag).
     */
    flags?: ClientFlags;
}
/**
 * A fully-assembled session-proxy runtime.
 *
 * Call `start()` to spawn tmux and bootstrap the pipeline.
 * Call `addClient(transport)` for each new client connection.
 * Call `stop()` / `kill()` for shutdown.
 */
export interface SessionProxy {
    /**
     * Read/event-only view of the underlying TmuxHost (tc-3si.9).
     *
     * Exposes onExit, onError, and exited — the only members external consumers
     * legitimately need.  Raw command writes are not available here; use
     * `sessionProxy.send(command)` instead, which routes through the pipeline's
     * slotted, instrumented path.
     */
    readonly host: SessionProxyHostView;
    /** The output demux (attach/detach transports, pause/resume panes). */
    readonly demux: OutputDemux;
    /** The live runtime pipeline (model, onModelChange). */
    readonly pipeline: RuntimePipeline;
    /** The control-plane server (addClient / removeClient / clientCount). */
    readonly server: ControlServer;
    /** The input & resize path (handleClientMessage). */
    readonly inputPath: InputPath;
    /** The flow controller (onPaneBytes / noteDrained / …). */
    readonly flowController: FlowController;
    /**
     * The metrics registry for this session-proxy (tc-x6l).
     *
     * Call `metrics.metrics()` to get the Prometheus text exposition for the
     * debug surface (e.g. `server-proxy.info` response). The registry accumulates
     * topology event counts, command counts, delta fan-out counts, and
     * command round-trip latency histograms.
     *
     * The storm alarm runs automatically once `start()` is called and logs to
     * stderr on sustained high topology-event rates.
     */
    readonly metrics: SessionProxyRegistry;
    /**
     * Start the sessionProxy: spawn tmux and run the bootstrap exchange.
     * Resolves once the pipeline is live (model populated).
     */
    start(): Promise<void>;
    /**
     * Accept a new client connection.
     *
     * Runs the handshake + snapshot on the control plane, then attaches
     * the demux to the transport's data plane and wires the input path.
     * Returns the NegotiatedSession.
     *
     * tc-295a.8 (W2.2): `opts.primaryPaneId` is the broker-forwarded target pane
     * this transport attached for (the pane the user is binding). When supplied,
     * the session-proxy validates it exists in the model and, after the snapshot,
     * guarantees its hydration (pane.hydration.begin → clear+replay → end) is
     * delivered before any live delta for it. A vanished primary pane surfaces
     * `pane.attach.failed{code:"pane.not-found"}` on this transport (fail-loud).
     * When omitted, every known pane is hydrated (the legacy bulk contract).
     *
     * D5 (tc-4b6k.4): `opts.preNegotiated` + `opts.startSeq` are the broker
     * single-socket handoff — the connection already completed the
     * `server-proxy.capabilities` handshake, so the session-proxy skips its own
     * handshake and continues the connection's seq counter from `startSeq`. When
     * both are omitted (in-memory test pairs, driver-admin one-shots) the
     * session-proxy runs its own handshake and starts the seq at 1.
     */
    addClient(transport: Transport, opts?: SessionProxyAddClientOptions): Promise<import("@tmuxcc/protocol").NegotiatedSession>;
    /**
     * tc-5quo — clear-then-replay hydration for the given transport.
     *
     * For every pane currently in the pipeline's model, send the canonical
     * full-history `capture-pane` command, then deliver
     * `\x1b[H\x1b[2J\x1b[3J` + capture body (with `\n`→`\r\n`) to `transport`
     * via `transport.sendData(paneId, ...)`.
     *
     * Used by `addClient` to provide the single hydration contract for all
     * bind paths (first attach, warm rebind, reconnect).  Exposed on the
     * interface so tests can drive it directly without re-running the full
     * handshake + snapshot dance.
     *
     * Fire-and-forget at the call site: returns a Promise that resolves
     * when every pane's capture-pane round-trip has completed (per-pane
     * errors are swallowed; one slow pane does not block siblings — all
     * panes run concurrently).  Callers may `await` to gate readiness in
     * tests; production wires it as `void hydrateClient(...)`.
     *
     * @internal — for the session-proxy's own `addClient` and for tests.
     */
    hydrateClient(transport: Transport): Promise<void>;
    /**
     * Send a tmux command through the pipeline's slotted, instrumented path (tc-3si.9).
     *
     * This is the only correct external command-send entry point: it delegates to
     * `pipeline.send(command)`, which atomically registers a correlator slot and
     * writes to the host — exactly the same slotted path used by input-path,
     * flow-control, and the monitor-bell setup in start().
     *
     * Do NOT call `sessionProxy.host.write(...)` — the host view intentionally
     * omits `write` to enforce this invariant.
     *
     * @param command - The tmux command string (without trailing newline).
     * @returns A Promise resolving with the CommandResult when tmux replies.
     */
    send(command: string): Promise<CommandResult>;
    /**
     * Graceful shutdown: close stdin → wait for tmux to exit (up to 3 s, then SIGKILL).
     */
    stop(): Promise<void>;
    /**
     * Forceful kill.  Idempotent.
     */
    kill(): void;
}
/**
 * Assemble the full session-proxy runtime.
 *
 * The returned SessionProxy is NOT started yet — call `sessionProxy.start()` to spawn tmux.
 *
 * Wiring order (important for correctness):
 *   1. createOutputDemux           — creates the tapped PaneBufferStore.
 *   2. createFlowController        — wraps host + demux (no pipeline yet).
 *   3. Wrap demux.store with a shim that calls fc.onPaneBytes per append.
 *   4. createRuntimePipeline       — uses the wrapped store as its buffers.
 *   5. createControlServer         — uses the pipeline's model/onModelChange.
 *   6. createInputPath             — uses the host for write().
 *
 * @param opts - Optional per-component options.
 */
export declare function createSessionProxy(opts: SessionProxyOptions): SessionProxy;
//# sourceMappingURL=session-proxy.d.ts.map