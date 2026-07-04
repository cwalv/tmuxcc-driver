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

import { createTmuxHost } from "./tmux-host.js";
import type { TmuxHost, TmuxHostOptions, ExitHandler, ErrorHandler } from "./tmux-host.js";
import { createOutputDemux } from "./output-demux.js";
import type { OutputDemux } from "./output-demux.js";
import { createRuntimePipeline } from "./pipeline.js";
import type { RuntimePipeline } from "./pipeline.js";
import { createControlServer } from "./serve.js";
import type { ControlServer, ControlServerOptions, AddClientOptions } from "./serve.js";
import type { ClientFlags } from "@tmuxcc/protocol";
import { createInputPath } from "./input-path.js";
import type { InputPath, InputPathOptions } from "./input-path.js";
import { createFlowController } from "./flow-control.js";
import type { FlowController, FlowControllerOptions } from "./flow-control.js";
import type { Transport } from "@tmuxcc/protocol";
import { paneId as mintPaneId } from "@tmuxcc/protocol";
import type { PaneId } from "@tmuxcc/protocol";
import type { PaneBufferStore } from "../state/scrollback.js";
import type { SwitchClientOutcome } from "../state/switch-client.js";
import { createSessionProxyRegistry, createStormAlarm } from "../metrics/index.js";
import type { SessionProxyRegistry, StormAlarmOptions } from "../metrics/index.js";
import type { CommandResult } from "../parser/correlator.js";
import { hydrateTransport, hydratePane, captureText } from "./hydration.js";
import type { HydrationSentinels } from "./hydration.js";
import { createVerbOriginRegistry } from "./verb-origin.js";
import { createCloseCauseRegistry } from "./close-cause.js";
import { createSizeOwnershipPolicy } from "./size-ownership.js";
import type { ResizeRequestMessage } from "@tmuxcc/protocol";
import type { Clock } from "../state/coalescer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
   * Size-ownership policy (tc-76m8.3, S3 "Geometry among peers"). Ownership of
   * the session size follows client activity (window-size-`latest` style);
   * `debounceMs` is the owner-silence hold before a more-recently-active peer
   * takes ownership (default {@link DEFAULT_SIZE_OWNERSHIP_DEBOUNCE_MS}). `clock`
   * is injectable so tests advance the debounce deterministically. Omit to
   * accept the defaults.
   */
  sizeOwnership?: {
    readonly debounceMs?: number;
    readonly clock?: Clock;
  };

  /**
   * Called when the per-session pipeline catches an unhandled exception
   * (tc-2x3.4 per-session error boundary).
   *
   * Forwarded to `RuntimePipelineOptions.onFatalError` behind a wrapper that
   * first broadcasts the FAULT farewell (`error{code:"internal"}`) and closes
   * every client transport (tc-76m8.38) — clients must see a fault close, not
   * the designed `session.unavailable` session-death goodbye that the
   * host-exit path emits.  In the collapsed single-process topology
   * (tc-2x3.3), a throwing pipeline can crash every session; this callback
   * lets the caller (the server-proxy supervisor) tear down and reattach ONLY
   * the affected session while leaving siblings running.
   *
   * When omitted, boundary trips are logged to stderr and the fault farewell
   * still goes out, but the session is NOT automatically recycled —
   * backward-compat for test setups that do not exercise the supervisor path.
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
   * `pullHydration: true` (tc-76m8.28) → skip the unsolicited addClient-time
   * bulk replay; this client hydrates each pane explicitly via `pane.attach`.
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
   * tc-76m8.28: `opts.flags.pullHydration` suppresses BOTH unsolicited forms
   * (bulk and targeted-primary) — the client hydrates each pane explicitly
   * via `pane.attach`, so the driver never replays a grid captured before the
   * client converged tmux to its tabs' geometry.
   *
   * D5 (tc-4b6k.4): `opts.preNegotiated` + `opts.startSeq` are the broker
   * single-socket handoff — the connection already completed the
   * `server-proxy.capabilities` handshake, so the session-proxy skips its own
   * handshake and continues the connection's seq counter from `startSeq`. When
   * both are omitted (in-memory test pairs, driver-admin one-shots) the
   * session-proxy runs its own handshake and starts the seq at 1.
   */
  addClient(
    transport: Transport,
    opts?: SessionProxyAddClientOptions,
  ): Promise<import("@tmuxcc/protocol").NegotiatedSession>;

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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
export function createSessionProxy(opts: SessionProxyOptions): SessionProxy {
  // 0. Metrics registry + storm alarm (tc-x6l).
  //
  //    Created before any component so the registry is always present. The
  //    storm alarm's timer is NOT started yet — we call alarm.start() inside
  //    the SessionProxy.start() method, after the pipeline is live, so the
  //    5-second window doesn't start counting from factory time (when no
  //    notifications can arrive yet).
  const metricsRegistry = createSessionProxyRegistry();
  const stormAlarm = createStormAlarm(opts.stormAlarm ?? {});

  // tc-ozk.2: verb-origin registry — correlates a creating verb's returned
  // effect ids (tc-ozk.1) to the connection + requestId that caused them, so
  // the creation deltas (pane.opened / window.added) the daemon emits carry
  // their `origin`. Recorded by the per-transport verb responder in addClient;
  // looked up by the control server's per-client diffModel; cleared when a
  // pane/window leaves the model (it can never be re-announced for that id).
  const verbOrigins = createVerbOriginRegistry();

  // tc-u7cu.6: close-cause registry — records which panes were closed by a
  // wire verb (close-pane / kill-window) so pane.closed deltas carry `cause`.
  // Recorded by the per-transport verb responder in addClient (at %end time,
  // which always arrives before a topology requery in tmux control mode);
  // consumed (one-shot) by diffModel when emitting pane.closed; cleared
  // defensively when a pane leaves the model (in case the consume path was missed).
  const closeCauses = createCloseCauseRegistry();

  // 1. Host
  const host = createTmuxHost(opts.host);

  // 2. Demux
  //
  // tc-3si.5: wire the pretopology-drop counter through. Provenance is
  // resolved at bind / close time inside the demux (see output-demux.ts);
  // the hook is fired with the accumulated byte count and the settled
  // label. Owned drops loud-log alongside the counter bump (the F4
  // symptom — a pane we own had bytes thrown away).
  const demux = createOutputDemux({
    onPretopologyDropped: (bytes, provenance) => {
      metricsRegistry.incPretopologyDroppedBytes(bytes, provenance);
      if (provenance === "owned") {
        process.stderr.write(
          `[output-demux] OWNED PRETOPOLOGY DROP: ${bytes} bytes dropped before the pane was bound to the model. ` +
            `This is the F4 symptom — bytes for a pane we own were thrown away; recapture-on-bind will fill the gap ` +
            `but the staging buffer cap (128 KiB) was too small for the bind delay (tc-3si.5).\n`,
        );
      }
    },
  });

  // 3. Flow controller — needs the pipeline's atomic `send` (slot + write)
  //    callback; pipeline not yet created.
  //
  // tc-3si.1: every tmux command write under the requery pipeline must be
  // slot+write atomic — there is no raw-host fallback. The flow controller
  // therefore takes a `send` callback rather than a host. We forward to the
  // pipeline through a late-binding closure (the pipeline doesn't exist yet,
  // but the first pause/continue cannot fire until the pipeline is live).
  let pipelineRef: RuntimePipeline | null = null;
  const fcSend = (command: string): Promise<import("../parser/correlator.js").CommandResult> => {
    if (pipelineRef === null) {
      // Should not happen: flow control requires live data flow, which only
      // starts after pipeline.start() resolves. Defensive: the unresolved
      // Promise would otherwise hang silently.
      throw new Error("[session-proxy] flow controller fired before pipeline was wired");
    }
    return pipelineRef.send(command);
  };
  // tc-d7i: invariant-tripwire hooks — registry counters plus loud stderr
  // for the expected-zero ones (the bytes-while-paused shape is expected
  // non-zero in bounded bursts, so it gets the counter only).
  const fc = createFlowController(fcSend, demux, {
    ...opts.flow,
    metrics: {
      onDrainClamped: (paneId, excessBytes) => {
        metricsRegistry.noteFlowDrainClamped();
        // PRE-ALPHA FAIL-LOUD (tc-76m8.27): an FC-1 accounting violation must
        // crash, not self-heal — the clamp used to absorb it into a stderr
        // warning that no test failed on (the abrupt-death credit bug lived
        // as ignorable log noise until tc-76m8.23 read the logs). The
        // invariant now holds by construction (the draining wrapper
        // suppresses post-close credits), so every remaining trip is a real
        // bug. Sync path: lands in the pipeline's per-session error boundary
        // (tc-2x3.4). Deferred path: an unhandled rejection → supervisor
        // respawn (tc-crnt.14). The metric is counted first so the
        // expected-zero counter still witnesses the trip.
        throw new Error(
          `[flow-control] DRAIN CLAMPED: pane ${paneId as string} drain credit exceeded buffered bytes by ${excessBytes}. ` +
            `Expected never — an FC-1 accounting bug (double credit / drain for a dead pane or client).`,
        );
      },
      onBytesWhilePaused: (_paneId, byteCount) => {
        metricsRegistry.noteFlowBytesWhilePaused(byteCount);
      },
      onCommandFailed: (kind) => {
        metricsRegistry.noteFlowCommandFailed(kind);
        process.stderr.write(
          `[flow-control] COMMAND FAILED: refresh-client -A ${kind} replied %error. ` +
            (kind === "continue"
              ? `tmux keeps holding this pane's output — if no later resume succeeds, the pane is frozen.\n`
              : `the pane was not paused tmux-side; backpressure is demux-gate-only until the next crossing.\n`),
        );
      },
    },
  });

  // 4. Wrap the demux store so the flow controller is notified of every append.
  //    The wrapper delegates everything to demux.store and additionally calls
  //    fc.onPaneBytes so backpressure accounting stays accurate.
  //
  //    tc-t4k1: COUNT BEFORE FAN-OUT. `demux.store.append` fans the bytes out to
  //    every attached transport synchronously; an un-backpressured socket's
  //    `sendData` returns void, so the draining wrapper credits `fc.noteDrained`
  //    SYNCHRONOUSLY inside that append call (the void branch). If we counted
  //    (onPaneBytes) only afterwards, the drain credit would land while the
  //    ledger still read 0 for these bytes — an FC-1 over-credit the clamp
  //    absorbed (the "DRAIN CLAMPED" tripwire). Incrementing the ledger first
  //    makes the credit-before-debit inversion impossible by construction: the
  //    byte is counted before any transport can drain it.
  //
  //    Pause-edge note (FC-2): when this append crosses HIGH_WATER, onPaneBytes
  //    pauses the pane *before* demux.store.append runs, so the crossing chunk
  //    is gated rather than fanned out. That is harmless — the chunk is already
  //    in the scrollback store (demux.store always appends to _inner) and is
  //    replayed on resume/hydration; no byte is lost, and the pane was going to
  //    be gated for the very next chunk anyway. Crucially it also means the
  //    crossing chunk is NOT drained synchronously, so it cannot invert.
  const accountingStore: PaneBufferStore = {
    append(paneId: PaneId, bytes: Uint8Array): void {
      if (bytes.length > 0) {
        fc.onPaneBytes(paneId, bytes.length);
      }
      demux.store.append(paneId, bytes);
    },
    getContents(paneId: PaneId): Uint8Array {
      return demux.store.getContents(paneId);
    },
    size(paneId: PaneId): number {
      return demux.store.size(paneId);
    },
    drop(paneId: PaneId): void {
      demux.store.drop(paneId);
    },
    clear(): void {
      demux.store.clear();
    },
  };

  // 5. Pipeline — uses the accounting (wrapped demux) store, plus session
  //    binding for switch-client narrowing (tc-j9c.7).
  //
  //    onSwitchClientDetected needs to call `server` (step 6), which is
  //    created after the pipeline.  We use a late-binding reference that is
  //    patched in step 6a immediately after server creation.  The callback
  //    fires only at live-notification time (after start()), so serverRef is
  //    always non-null by then.
  let serverRef: ControlServer | null = null;

  // tc-fah2: discriminate user-caused session death from external/unattributed death.
  //
  // We want to set _paneExitHeadedCascade = true ONLY when the session dies because
  // the last pane's process exited naturally (e.g. user typed `exit`), NOT because of
  // an external kill (kill-server, kill-session, SIGTERM to the tmux server).
  //
  // WHAT TMUX ACTUALLY SENDS (empirically confirmed, tmux 3.4):
  //   Natural death (pane exits → session dies): %output... %sessions-changed %exit
  //   External kill (kill-server):               %sessions-changed %exit
  //
  //   Both paths produce %sessions-changed then %exit.  tmux does NOT send %window-close
  //   to the CC client of the dying session: by the time the async command queue fires
  //   control_notify_window_unlinked(), c->session is already NULL (set in
  //   server_destroy_session), so the %window-close write is skipped.  Similarly,
  //   %pane-exited is a HOOK (not a CC notification) and requires remain-on-exit.
  //
  // THE DISCRIMINATOR (output-recency heuristic):
  //   When the user types `exit`, the shell echoes back the command and possibly prints
  //   a logout message — producing %output events within ~100ms of %sessions-changed.
  //   External kills produce no pane output just before %sessions-changed.
  //
  //   So: if a %output/%extended-output event arrived within 500ms of %sessions-changed,
  //   it is very likely a pane-exit cascade.  If no recent output, it is external.
  //
  //   The 500ms window is intentionally short: normal typing produces output well
  //   before the session closes, and external kills arrive without prior output.
  //
  // STARTUP GUARD (_modelStabilized):
  //   The %output events from shell prompts during session startup are excluded by only
  //   tracking output AFTER the first onModelChange fires (model bootstrapped).  This
  //   prevents startup prompts from polluting the kill-server discrimination.
  //
  // Declared here (before createRuntimePipeline) so the onTopologyNotify callback
  // below can reference it at closure-creation time (even though it's a let — the
  // callback is only CALLED after start(), by which point the variable is initialized).
  let _paneExitHeadedCascade = false;
  let _lastOutputTs = 0;   // timestamp of most recent %output/%extended-output event
  let _modelStabilized = false; // true after first onModelChange (bootstrap done)

  const pipeline = createRuntimePipeline(host, {
    buffers: accountingStore,
    sessionName: opts.host.sessionName,
    // tc-3si.6: thread the metrics registry into the pipeline so it can
    // instrument command_round_trip_seconds{kind}, the
    // topology_notify_to_delta_seconds{edge} histogram, deltas_emitted_total,
    // output_bytes_total + output_frame_size_bytes — the latency / throughput
    // shapes documented in docs/observability.md.
    metrics: metricsRegistry,
    // tc-2x3.4: per-session error boundary — forward the fatal-error hook so
    // the supervisor can tear down + reattach only this session on a pipeline
    // exception, without affecting siblings (tc-2x3.4).
    //
    // tc-76m8.38: FAULT farewell.  A boundary trip means the session-proxy
    // itself broke while the tmux session is (as far as we know) still alive.
    // The supervisor teardown that follows funnels through stop() → host exit,
    // whose farewell says "session.unavailable" — the DESIGNED session-death
    // goodbye that tells clients to stand down their crash reaction.  That is
    // a mis-attribution here (per the WireErrorCode vocabulary,
    // "session.unavailable" = the session has gone away; "internal" = an
    // unexpected session-proxy-side error).  Broadcast the fault farewell with
    // code "internal" FIRST — before the supervisor's teardown closes the
    // transports — so clients keep their unexpected-disconnect recovery
    // (reconnect affordance) instead of treating this as a session death.
    // The later host-exit broadcast then finds no clients and is a no-op.
    onFatalError: (err: unknown): void => {
      serverRef?.broadcastErrorAndClose({
        type: "error",
        code: "internal",
        message:
          "The session-proxy hit an internal error; the tmux session may still be running.",
      });
      opts.onFatalError?.(err);
    },
    // tc-x6l: per-kind counters + storm alarm attach to the topology
    // classification choke point — the coalescer's onNotify path, surfaced
    // through this pipeline option. The hook only fires for topology-
    // classified notifications (output/pause/continue and the optimistic
    // internal:* events never count); the storm alarm and counters only
    // care about topology rate, so this is the right scope.
    //
    // tc-2x3.4: also forward opts.onTopologyNotify so callers (tests, the
    // supervisor) can observe topology events from outside — and, critically,
    // so tests can inject a throwing hook to exercise the error boundary.
    // A throw from opts.onTopologyNotify propagates up through _dispatchEvent
    // into the host.onData try/catch, triggering the boundary exactly as a
    // real parser/reducer exception would.
    onTopologyNotify: (kind) => {
      metricsRegistry.incTopologyEvent(kind);
      stormAlarm.record(kind);
      // Forward to the caller's hook AFTER the internal instrumentation.  If
      // the caller's hook throws, the boundary catches it via the wrapping
      // try/catch in host.onData — this is intentional (the throw is the
      // fault-injection path).
      opts.onTopologyNotify?.(kind);
      // tc-fah2: output-recency discriminator for pane-exit vs external death.
      //
      // %sessions-changed fires for BOTH natural pane-exit death AND external
      // kill-server.  We distinguish them by whether recent pane %output arrived
      // within the 500ms window (see the comment above the let declarations for
      // the full rationale).  The flag is rewritten on every %sessions-changed so
      // the last value before host.onExit fires is always current.
      if (kind === "sessions-changed") {
        _paneExitHeadedCascade = _lastOutputTs > 0 && Date.now() - _lastOutputTs < 500;
      }
    },
    onSwitchClientDetected: (outcome: SwitchClientOutcome) => {
      if (outcome === "reattach") {
        // The bound session is still alive but the -CC client drifted away.
        // Silently issue attach-session to pull it back.  No wire emission.
        //
        // tc-3si.1: pipeline.send atomically registers a correlator slot and
        // writes — this fires AFTER pipeline.start(), so the requery engine is
        // live; without the slot the attach-session %end reply would mis-bind
        // to the next requery's list-* slot, corrupting the topology snapshot.
        if (!host.exited) {
          void pipelineRef?.send("attach-session -t " + opts.host.sessionName);
        }
      } else {
        // outcome === "unavailable": the bound session is gone.
        // Broadcast the error and close all client connections.
        serverRef?.broadcastErrorAndClose({
          type: "error",
          code: "session.unavailable",
          message: "The bound tmux session is no longer available.",
        });
      }
    },
  });

  // 5a. Patch the late-binding pipeline reference so the flow-controller's
  //     `send` seam (and the switch-client attach-session writer installed in
  //     step 5) can reach the pipeline now that it exists. Both callsites only
  //     fire after pipeline.start() resolves, so the slot/write wiring is
  //     always live by then (tc-3si.1).
  pipelineRef = pipeline;

  // 5b. tc-fah2: arm the output-recency tracker for the pane-exit discriminator.
  //
  //     We subscribe to onNotification to track %output/%extended-output events.
  //     The _modelStabilized gate excludes startup shell prompts (which arrive before
  //     the first onModelChange / bootstrap) from the signal; only post-bootstrap
  //     output (i.e. interactive user activity) counts toward the 500ms window.
  //
  //     onModelChange is also used in step 8 for the pane-close latch; these are
  //     independent subscribers — the pipeline supports multiple.
  pipeline.onModelChange(() => {
    _modelStabilized = true;
  });
  pipeline.onNotification((event) => {
    if (!_modelStabilized) return;
    if (event.kind === "output" || event.kind === "extended-output") {
      _lastOutputTs = Date.now();
    }
  });

  // 6. Control-plane server.
  //
  // tc-3si.6: thread the metrics registry so the server can increment
  // deltas_fanned_out_total{client="cN"} per per-client delta. The
  // pipeline owns the denominator (deltas_emitted_total); the server owns
  // the numerator.
  const server = createControlServer(pipeline, {
    ...opts.server,
    metrics: metricsRegistry,
    // tc-ozk.2: per-client delta tagging consults the verb-origin registry.
    originLookup: (id) => verbOrigins.lookup(id),
    // tc-u7cu.6: pane.closed tagging consults the close-cause registry (consume).
    closeCauseLookup: (id) => closeCauses.consume(id),
    // tc-is5w: tag the dev-gated first-snapshot timing line with the session.
    sessionName: opts.host.sessionName,
  });

  // 6a. Patch the late-binding reference so the switch-client callback
  //     installed in step 5 can reach the server.
  serverRef = server;

  // 7. Input path — with synthetic-dispatch wired to the pipeline so that
  //    optimistic model updates (e.g. set-synchronize-panes, tc-7xv.12) are
  //    applied immediately without waiting for a tmux notification.
  //
  //    send + sendBatch are the only command-write paths (tc-3si.1): each
  //    atomically registers a correlator slot before writing. getModel is
  //    also wired so that tc-7xv.37 error reversal can capture the
  //    before-state for rollback when tmux replies with %error.
  const inputPath = createInputPath(
    {
      send: (cmd) => pipeline.send(cmd),
      sendBatch: (cmds) => pipeline.sendBatch(cmds),
    },
    {
      ...opts.input,
      dispatchSynthetic: (event) => pipeline.injectNotification(event),
      getModel: () => pipeline.getModel(),
    },
  );

  // 7a. Size-ownership policy (tc-76m8.3, S3 "Geometry among peers").
  //
  //     D4's MECHANISM is frozen: only the size OWNER's `resize.request` reaches
  //     `refresh-client -C`; non-owners' are dropped. This POLICY decides WHO
  //     owns — the most-recently-ACTIVE client (window-size-`latest`), debounced
  //     so simultaneous typing across peers can't ping-pong reflows. Activity =
  //     `input` traffic + explicit `client.focus`; mere connection is not.
  //
  //     `lastResizeByClient` remembers each client's latest desired viewport
  //     (even non-owners: a non-owner's resize is dropped, but if it later wins
  //     ownership its size must be applied so tmux reflows to it — otherwise the
  //     newly-active window would be stuck at the previous owner's geometry). On
  //     an ownership change we replay the new owner's last resize through the
  //     input path (which bypasses the owner gate, being an internal re-apply).
  const lastResizeByClient = new Map<string, ResizeRequestMessage>();
  const sizeOwnership = createSizeOwnershipPolicy({
    ...(opts.sizeOwnership?.debounceMs !== undefined
      ? { debounceMs: opts.sizeOwnership.debounceMs }
      : {}),
    ...(opts.sizeOwnership?.clock !== undefined ? { clock: opts.sizeOwnership.clock } : {}),
    onOwnerChange: (ownerKey) => {
      if (ownerKey === null) return;
      const last = lastResizeByClient.get(ownerKey);
      if (last === undefined) return;
      // Re-apply the new owner's viewport: D4 mechanism (refresh-client -C) via
      // the input path, bypassing the per-transport owner gate in addClient.
      inputPath.handleClientMessage(last);
    },
  });

  // 8. Route %pause / %continue notifications from the pipeline to the
  //    FlowController.  These are content-plane signals, not topology — they
  //    don't fire onTopologyNotify (and don't change the model), so we keep
  //    the explicit subscription via pipeline.onNotification (which fires for
  //    every parsed event regardless of category).
  //
  //    %extended-output byte accounting is already handled by accountingStore
  //    (which calls fc.onPaneBytes on every append).
  //
  //    tc-x6l counter increments + storm alarm record live in the pipeline's
  //    onTopologyNotify hook above (wired at construction). That hook fires
  //    once per topology-classified notification — the single choke point the
  //    coalescer was shaped for — so we don't double-count by also recording
  //    here.
  // tc-3si.6: track per-pane pause/resume so the registry can accumulate
  // session_paused_seconds_total. We mirror the FlowController's own
  // pause set rather than counting raw %pause / %continue events because
  // tmux can emit redundant %pause for an already-paused pane (e.g. when
  // tmux's own capacity management decides to pause something the
  // controller already paused). Keeping a local set keeps the refcount in
  // the registry exactly equal to the number of actually-paused panes.
  const _metricsPaused = new Set<string>();

  pipeline.onNotification((event) => {
    if (event.kind === "pause") {
      const pid = mintPaneId("p" + event.paneId);
      fc.onPauseNotification(pid);
      if (!_metricsPaused.has(pid)) {
        _metricsPaused.add(pid);
        metricsRegistry.notePauseEntered();
        // tc-3si.5: pane-level pause gauge + totals. Pairs with
        // notePauseEntered (the session-time accumulator that already
        // existed in tc-3si.6) — distinct surfaces because session-time
        // is "fraction of session paused", and the gauge/totals are
        // "are there currently stuck panes? do pauses balance resumes?"
        metricsRegistry.notePanePauseEntered();
      }
    } else if (event.kind === "continue") {
      const pid = mintPaneId("p" + event.paneId);
      fc.onContinueNotification(pid);
      if (_metricsPaused.has(pid)) {
        _metricsPaused.delete(pid);
        metricsRegistry.notePauseExited();
        metricsRegistry.notePanePauseExited();
      }
    }
  });

  // 9. Output-before-topology buffering (tc-128.3, tc-128.4).
  //
  // The demux holds fan-out for panes not yet known to the topology model
  // (under requery, a %output frame can arrive for a pane before the requery
  // snapshot reveals it). Pane tracking is always-on (tc-128.4 removed the
  // opt-in); we keep the demux's known-pane set in sync by watching
  // model-change events: new panes → notifyPaneBound, removed panes →
  // notifyPaneClosed.
  //
  // Ordering note: this subscription fires BEFORE per-client model-change
  // subscriptions (which are registered in addClient(), called after factory
  // time). notifyPaneBound uses queueMicrotask to defer the flush so that
  // control-plane `pane.opened` deltas reach clients before the flushed data
  // bytes. See output-demux.ts notifyPaneBound for details.
  //
  // Bootstrap path: pipeline.ts emits the initial model-change as
  // (initialModel, initialModel) — same reference for both prev and next —
  // so diffModel(prev, next) would yield zero deltas and miss the bootstrap
  // panes. We use demux.isPaneKnown() for addition detection so ALL panes
  // present in the next model are bound, including those that first appear
  // in bootstrap.
  pipeline.onModelChange((next, prev) => {
    for (const pid of next.panes.keys()) {
      if (!demux.isPaneKnown(pid)) {
        demux.notifyPaneBound(pid);
      }
    }
    for (const pid of prev.panes.keys()) {
      if (!next.panes.has(pid)) {
        demux.notifyPaneClosed(pid);
        // tc-ozk.2: a removed pane's creation can never be re-announced for that
        // id, so drop any recorded verb-origin (bounds the registry alongside
        // its TTL/size cap).
        verbOrigins.clear(pid);
        // tc-u7cu.6: defensive clear — the close-cause registry uses one-shot
        // consume semantics (diffModel.closeCauseLookup already consumed it), but
        // clear here in case the registry wasn't wired or the pane vanished
        // through a path that bypassed diffModel (e.g. session shutdown).
        closeCauses.clear(pid);
      }
    }
    for (const wid of prev.windows.keys()) {
      if (!next.windows.has(wid)) {
        // tc-ozk.2: same for a removed window.
        verbOrigins.clear(wid);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // SessionProxy handle
  // ---------------------------------------------------------------------------

  // tc-3si.9: Expose a read/event-only view of the host rather than the raw
  // TmuxHost.  External consumers legitimately need onExit, onError, and
  // exited — nothing else.  Raw write() is intentionally absent; callers must
  // use sessionProxy.send(command) which routes through the slotted pipeline.
  const hostView: SessionProxyHostView = {
    onExit: (handler) => host.onExit(handler),
    onError: (handler) => host.onError(handler),
    get exited() { return host.exited; },
  };

  // tc-yhxm: test seam — make the raw TmuxHost reachable from hostView for
  // pty-error injection in EB7 (session-error-boundary.test.ts).
  // Non-enumerable, non-writable; not in the SessionProxyHostView interface.
  // Tests access via: (proxy.host as any)._rawHost._pty.emit("error", ...)
  Object.defineProperty(hostView, "_rawHost", {
    value: host,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  // ---------------------------------------------------------------------------
  // tc-295a.8 / tc-295a.9 — per-pane attach + hydration helpers.
  //
  // Both close over `demux`, `server`, and `pipeline`. `makeSentinels` binds
  // the begin/end window to a specific (control transport, draining transport)
  // pair so the data-plane queue gate and the control-plane sentinels target
  // the same client. `attachAndHydratePane` validates pane existence and
  // surfaces pane.attach.failed{pane.not-found} when the pane is gone.
  // ---------------------------------------------------------------------------

  /**
   * Build the HydrationSentinels for one client.
   *
   * `controlTransport` is the raw transport the ControlServer knows (for seq-
   * stamped sendDirected); `dataTransport` is the demux-attached draining
   * wrapper the live %output fan-out targets (for the no-interleave queue gate).
   * They wrap the same socket — the queue must gate the SAME object the demux
   * fans out to, while the sentinels ride the control plane.
   */
  function makeSentinels(
    controlTransport: Transport,
    dataTransport: Transport,
  ): HydrationSentinels {
    return {
      begin(pid: PaneId): void {
        // Start queueing live bytes for this (transport, pane) BEFORE emitting
        // begin, so no live byte slips out between the sentinel and the gate.
        demux.beginPaneHydration(dataTransport, pid);
        server.sendDirected(controlTransport, {
          type: "pane.hydration.begin",
          paneId: pid,
        });
      },
      end(pid: PaneId): void {
        // Flush the queued live bytes (they land after the clear+replay frame
        // the hydrator just delivered), THEN emit end.
        demux.endPaneHydration(dataTransport, pid);
        server.sendDirected(controlTransport, {
          type: "pane.hydration.end",
          paneId: pid,
        });
      },
    };
  }

  /**
   * Validate `pid` exists in the model and hydrate it.
   *
   * tc-t4k1: the clear+replay frame is delivered on `replayTransport` (the RAW
   * control transport), NOT on the draining wrapper. The replay body comes from
   * `capture-pane` — it never passed through `fc.onPaneBytes`, so crediting it
   * via `fc.noteDrained` (which the draining wrapper does on every sendData)
   * over-credits the FC-1 ledger and trips the "DRAIN CLAMPED" tripwire. The
   * `sentinels` still gate the DRAINING transport (the object the demux fans
   * live %output out to), so the no-interleave queue contract is unchanged; only
   * the replay frame itself bypasses the drain-credit path. See the addClient
   * `drainingTransport` comment for the full accounting argument.
   *
   * On a vanished pane, emits pane.attach.failed{pane.not-found} (fail-loud)
   * and skips the capture round-trip. The capture itself can ALSO reveal the
   * pane is gone (closed between the model check and the capture reply); that
   * path likewise surfaces pane.not-found.
   */
  async function attachAndHydratePane(
    controlTransport: Transport,
    replayTransport: Transport,
    sentinels: HydrationSentinels,
    pid: PaneId,
  ): Promise<void> {
    if (!pipeline.getModel().panes.has(pid)) {
      server.sendDirected(controlTransport, {
        type: "pane.attach.failed",
        paneId: pid,
        code: "pane.not-found",
        message: `Pane ${pid as string} is not present in the session model.`,
      });
      return;
    }
    const found = await hydratePane(pipeline, replayTransport, pid, sentinels);
    if (!found) {
      server.sendDirected(controlTransport, {
        type: "pane.attach.failed",
        paneId: pid,
        code: "pane.not-found",
        message: `Pane ${pid as string} could not be captured (it may have closed mid-attach).`,
      });
    }
  }

  const sessionProxyHandle = {
    host: hostView,
    demux,
    pipeline,
    server,
    inputPath,
    flowController: fc,
    metrics: metricsRegistry,

    async start(): Promise<void> {
      await host.start();
      await pipeline.start();

      // tc-x6l: start the storm alarm AFTER the pipeline is live so the
      // 5-second window doesn't eat into factory-time silence.
      stormAlarm.start();

      // tc-5166i: Enable monitor-bell on all windows in the attached session.
      //
      // `monitor-bell` is a window option that causes tmux to note bell events
      // in its status line (and, in control mode, to handle bell tracking).
      // Although tmux defaults to `monitor-bell on`, users may have turned it
      // off in ~/.tmux.conf. We override it globally so tmuxcc panes always
      // forward BEL bytes correctly via the %output stream.
      //
      // We also set `bell-action none` so that in the unlikely case the
      // control-mode client is connected to a real terminal, tmux does not
      // try to ring that terminal's bell (it would go nowhere in control mode,
      // but this is clean hygiene).
      //
      // tc-3si.1: both writes go through pipeline.send so each atomically
      // registers a correlator slot — required under the requery pipeline so
      // the %end replies don't mis-bind to a concurrent requery's list-* slot.
      if (!host.exited) {
        void pipeline.send("set-option -g monitor-bell on");
        void pipeline.send("set-option -g bell-action none");
      }

      // tc-yhxm: discriminate pty read-fault exits from genuine session deaths.
      //
      // A tc-crnt.14-class pty read-fault fires host.onError() BEFORE
      // host.onExit(): tmux-host.ts's ptyEmitter.on("error", ...) calls
      // _emitError(err) synchronously (setting _exited=true and firing all
      // _errorHandlers), while term.onExit only fires later when the tmux
      // process actually terminates.  We latch this ordering in a flag so the
      // host.onExit() handler can emit the right farewell code.
      //
      // Farewell vocabulary (WireErrorCode / tc-76m8.38):
      //   "session.unavailable" = the session has gone away (S7 silence —
      //     the C1 sessions.removed drain owns teardown; clients stand down
      //     their crash reaction).
      //   "internal" = unexpected proxy-side error (keep toast + [Reconnect]
      //     recovery — the session may still be alive).
      // A pty read-fault while the tmux session survives is the latter, not the
      // former; before this fix it was mis-attributed as "session.unavailable"
      // (leaving a silent dead tab: missing toast + lingering tab, tc-yhxm).
      let _exitCausedByReadFault = false;
      host.onError((_err: Error) => {
        // Any error reaching this point is already non-EIO/EAGAIN: tmux-host.ts
        // filters benign pty-close codes before calling _emitError, so this
        // handler only fires for genuine pty read-socket faults (tc-crnt.14
        // class: EBADF, etc.).  Spawn failures also route here, but they never
        // produce a host.onExit() follow-up, so the flag is harmless in that
        // path.
        _exitCausedByReadFault = true;
      });

      // Subscribe to host.onExit so that when tmux dies unexpectedly the
      // session-proxy tears down its pipeline and notifies all connected clients.
      host.onExit(() => {
        // tc-fah2: SIGCHLD (which fires term.onExit in node-pty) can race the
        // delivery of remaining pty data (e.g. the %sessions-changed notification
        // that updates _paneExitHeadedCascade via the output-recency discriminator).
        // Defer the teardown and farewell by one event-loop turn so that any pending
        // onData events (which fire in the same "poll" phase libuv iteration) have a
        // chance to be processed by the pipeline's onData handler before we stop it.
        // setImmediate fires in the "check" phase, after the current poll-phase I/O.
        //
        // Mirror stop() — except host.stop(), since we're already in the exit
        // handler. tc-3si.11: the alarm and registry metronomes MUST stop
        // here too; this path used to stop only the pipeline, and the leaked
        // 1s alarm tick pinned any embedding process forever (wedged the
        // vscode unit suite at exit; would be a timer leak in the collapsed
        // single-process server after tc-2x3 Stage 2).
        setImmediate(() => {
          stormAlarm.stop();
          metricsRegistry.stop();
          pipeline.stop();
          sizeOwnership.dispose();

          // tc-zcqr / tc-1a9d: push farewell AND close client transports.
          // The transport close is the wire-level signal the extension's
          // `ServerProxySessionProxyHandle.onDisconnect` watches — without it,
          // `handleTransportDisconnect` never fires after a tmux kill-server, so
          // `showReconnectNotification` ("tmuxcc: connection lost.") doesn't run.
          // The "switch-client" outcome="unavailable" branch above already uses
          // broadcastErrorAndClose for the same reason; the tmux-death path matches.
          //
          // tc-yhxm: choose the farewell code based on the discriminator flag:
          //   - pty read-fault (onError fired first): "internal" — unexpected
          //     proxy-side error; clients keep toast + [Reconnect] recovery.
          //   - genuine session death: "session.unavailable" — S7 silence;
          //     the C1 sessions.removed drain owns teardown (tc-76m8.38).
          // tc-fah2: include the causation tag on session.unavailable farewells so the
          // client can discriminate user-caused death (pane-exit → silence) from external
          // death (external → one explanatory toast).  Not applicable to "internal" faults
          // (the tmux session may still be alive; causation is about the proxy itself).
          server.broadcastErrorAndClose({
            type: "error",
            code: _exitCausedByReadFault ? "internal" : "session.unavailable",
            message: _exitCausedByReadFault
              ? "The session-proxy hit an internal error; the tmux session may still be running."
              : "The tmux session has exited unexpectedly.",
            ...(!_exitCausedByReadFault ? {
              cause: _paneExitHeadedCascade ? "pane-exit" : "external",
            } : {}),
          });
        });
      });
    },

    async addClient(transport: Transport, opts: SessionProxyAddClientOptions = {}) {
      const { primaryPaneId } = opts;
      const clientFlags: ClientFlags | undefined = opts.flags;
      // 1. Run control-plane handshake + send snapshot + subscribe deltas.
      //    D5 (tc-4b6k.4): forward the broker handoff (skip handshake, continue
      //    the connection's seq) to the control server.
      //    D4 (tc-4b6k.3): forward flags so serve.ts stores them for info.
      const session = await server.addClient(transport, {
        ...(opts.startSeq !== undefined ? { startSeq: opts.startSeq } : {}),
        ...(opts.preNegotiated !== undefined ? { preNegotiated: opts.preNegotiated } : {}),
        ...(clientFlags !== undefined ? { flags: clientFlags } : {}),
      });

      // 1a'. Size-ownership registration (tc-76m8.3). Key by the durable client
      //      identity (D2) when present, else the connection id — both stable for
      //      this transport's lifetime. A client is a size CANDIDATE unless it
      //      attached with `ignore-size` or `read-only` (tmux `attach -r` parity:
      //      those flags mean "never drive size"). The first candidate becomes
      //      owner immediately; thereafter ownership follows activity.
      const clientKey: string =
        server.clientIdentityFor(transport)?.id ??
        (server.connectionIdFor(transport) as unknown as string);
      const isSizeCandidate =
        clientFlags?.ignoreSize !== true && clientFlags?.readOnly !== true;
      sizeOwnership.addClient(clientKey, isSizeCandidate);

      // 1a. Register this client's FC-1 sub-ledger (tc-0wtb). The demux fans one
      //     %output append out to EVERY attached transport, so each client owes
      //     those bytes independently until its own draining transport credits
      //     them back. The shared single ledger over-credited by (N−1)·n per
      //     fanned-out chunk and silently disabled backpressure for N≥2 clients;
      //     per-client sub-ledgers pause on the slowest and resume only when all
      //     are drained. The client key is the raw `transport` (stable identity;
      //     the same object the draining-wrapper closure below credits against,
      //     and the same object removeClient drops on transport close).
      //
      //     A client attaching mid-flood correctly starts at 0: its history
      //     replay rides the RAW transport (never counted by fc.onPaneBytes), so
      //     only live deltas from this point forward are credited.
      fc.addClient(transport);

      // 2. Wire data plane: attach a wrapped transport to the demux so that
      //    each sendData call also notifies the flow controller that bytes have
      //    been drained from the backpressure counter for that pane.
      //
      //    tc-7xv.6 / tc-7xv.24 wedge fix: the noteDrained call MUST be paired
      //    with actual transport drain.  Previously we called noteDrained
      //    synchronously after transport.sendData returned, which credited
      //    bytes as drained the instant they entered the kernel send buffer —
      //    so the session-proxy never observed real consumer backpressure and tmux
      //    was never told to pause.  Now we await the Promise returned by
      //    transport.sendData (set when the underlying socket is backpressured)
      //    and only credit drain after the socket reports 'drain'.
      //
      //    Without this call fc.bufferedBytes grows monotonically and a pane
      //    that crosses the high-water mark is paused and NEVER resumed — the
      //    resume path (fc.noteDrained → below low-water → _resume) never fires
      //    because nothing decrements the counter.
      //
      //    tc-76m8.27: `closed` suppresses drain credits once this transport's
      //    close handler (step 4 below) has run.  SocketTransport's close path
      //    resolves the shared drain promise (to release awaiters) and THEN
      //    fires its close handlers synchronously, so the deferred `.then`
      //    credits below run as microtasks strictly AFTER fc.removeClient has
      //    discarded this client's sub-ledgers.  Bytes that died in the send
      //    queue were never drained by anyone — removeClient IS the
      //    reconciliation for a dead client — so crediting them would debit a
      //    discarded ledger: one FC-1 "DRAIN CLAMPED" tripwire hit per queued
      //    chunk on every abrupt client death (SIGSTOP+flood+SIGKILL).  A
      //    credit released by the close path is not a drain; drop it.
      //
      //    We wrap only sendData; all other Transport methods are forwarded
      //    unchanged so the demux sees a fully-conforming Transport.
      let closed = false;
      const drainingTransport: Transport = {
        ...transport,
        sendData(pid: PaneId, bytes: Uint8Array): void | Promise<void> {
          const result = transport.sendData(pid, bytes);
          if (bytes.length === 0) return result;
          // tc-0wtb: credit THIS client's sub-ledger only (key = raw transport),
          // matching the per-client fan-out the demux performs. Crediting the
          // shared ledger would over-debit by (N−1)·n under multiple clients.
          //
          // Promise<void>: transport is backpressured; defer the drain credit
          // until the underlying socket reports drain.
          if (result !== undefined && typeof (result as Promise<void>).then === "function") {
            return (result as Promise<void>).then(() => {
              // Checked at settle time: a promise released by the transport's
              // close path (not a real socket drain) must not credit.
              if (closed) return;
              fc.noteDrained(pid, bytes.length, transport);
            });
          }
          // void: kernel send buffer accepted the bytes immediately.  Credit
          // drain synchronously — there's no further wait.  Unless the
          // transport already closed: then the underlying sendData no-opped
          // (dual guard on _closed/destroyed) and the bytes went nowhere —
          // e.g. a hydration queue flush racing client death.
          if (closed) return undefined;
          fc.noteDrained(pid, bytes.length, transport);
          return undefined;
        },
      };
      const detach = demux.attachTransport(drainingTransport);

      // 2a. tc-5quo: clear-then-replay hydration for every pane known to the
      //     model at attach time.
      //
      //     Without this step, a warm-rebind / reconnect leaves the client's
      //     terminal buffer holding whatever was there before the disconnect
      //     gap, and the gap's output is silently lost.  We unify the
      //     hydration contract for ALL bind paths (first bind, warm rebind,
      //     reconnect) by shelling `capture-pane -t %N -p -e -S - -E -`
      //     through the slotted pipeline for each known pane, then sending
      //     `\x1b[H\x1b[2J\x1b[3J` (cursor home + erase screen + erase
      //     scrollback) followed by the capture body (with `\n` → `\r\n` for
      //     terminal display) to THIS transport only.
      //
      //     Race trade-off: between `capture-pane` send and the reply, %output
      //     for the same pane may already have been fanned out to this
      //     transport's sendData.  The clear escape wipes those, and the
      //     capture body includes pre-reply bytes; any post-reply bytes are
      //     not in the capture body and are delivered live afterwards.  The
      //     race window is bounded by one tmux command round-trip and only
      //     matters for panes actively producing output at the instant of
      //     attach — rare in practice.
      //
      //     Fire-and-forget: we do NOT await before returning from addClient.
      //     Holding addClient until hydration completes would delay the
      //     client's "session established" signal by ~one capture-pane RTT
      //     per pane; clients already render live deltas correctly while
      //     hydration is in flight (any pre-hydration deltas land on the
      //     replayed history, then the clear+replay arrives and the live
      //     stream resumes from there).
      //
      //     tc-295a.9: wrap each pane's clear+replay with hydration sentinels
      //     and the demux no-interleave queue gate (see makeSentinels).
      //
      //     tc-t4k1: the sentinels gate the DRAINING transport (the demux's
      //     fan-out target), but the clear+replay frame is delivered on the RAW
      //     `transport` — its bytes come from capture-pane and were never
      //     counted by fc.onPaneBytes, so routing them through the draining
      //     wrapper would credit fc.noteDrained for un-buffered bytes and
      //     over-credit the FC-1 ledger. See attachAndHydratePane's docstring.
      const sentinels = makeSentinels(transport, drainingTransport);

      // tc-76m8.28: a client that declared `pullHydration` owns the WHEN of
      // every replay — it requests each pane explicitly via `pane.attach`
      // (the extension gates those on settled geometry, tc-76m8.24). Pushing
      // the addClient-time capture at it would replay a grid captured BEFORE
      // the client converges tmux to its tabs' geometry: on a reconnect with
      // geometry changed during the blip, history rows land in-viewport on
      // the open tab and the managed resize's SIGWINCH redraw destroys them
      // (the tc-76m8.24 corruption class, via this entry point). Skip the
      // unsolicited replay entirely; `pane.attach` (below) is this client's
      // single hydration entry point — including the targeted-attach primary
      // pane, whose validation (pane.attach.failed{pane.not-found}) moves to
      // the client's own `pane.attach` for it.
      if (clientFlags?.pullHydration !== true) {
        if (primaryPaneId !== undefined) {
          // tc-295a.8: broker-forwarded targeted attach. Validate the primary
          // pane exists; hydrate it FIRST (guaranteed before any live delta for
          // it), then hydrate the remaining known panes. A vanished primary pane
          // surfaces pane.attach.failed{pane.not-found} — fail-loud.
          void attachAndHydratePane(transport, transport, sentinels, primaryPaneId).then(() => {
            const others: PaneId[] = [];
            for (const pid of pipeline.getModel().panes.keys()) {
              if (pid !== primaryPaneId) others.push(pid);
            }
            void hydrateTransport(pipeline, transport, others, sentinels);
          });
        } else {
          void hydrateTransport(
            pipeline,
            transport,
            pipeline.getModel().panes.keys(),
            sentinels,
          );
        }
      }

      // 3. Wire input path: forward client control messages to tmux.
      //
      //    NOTE: transport.onControl is single-slot (replace semantics), so this
      //    overwrites the handler installed by server.addClient in step 1.  The
      //    serve layer's handler handled resync.request; we must proxy it here to
      //    avoid silently dropping resync requests and permanently stalling the
      //    mirror's seq-gap recovery (tc-tfv.11).
      transport.onControl((msg) => {
        if (msg.type === "resync.request") {
          server.handleResyncRequest(transport);
          return;
        }

        // tc-295a.8: mid-connection per-pane attach. The client binds a new tab
        // to an existing pane on this already-connected session (§1.4 bindNew)
        // and asks for on-demand hydration of THAT pane on this transport.
        // Validate + hydrate; a vanished pane surfaces pane.attach.failed.
        if (msg.type === "pane.attach") {
          const attach = msg as import("@tmuxcc/protocol").PaneAttachMessage;
          // tc-t4k1: replay frame on the RAW transport (see addClient); the
          // sentinels still gate the draining transport for no-interleave.
          void attachAndHydratePane(
            transport,
            transport,
            makeSentinels(transport, drainingTransport),
            attach.paneId,
          );
          return;
        }

        // tc-76m8.3 (S3): client.focus — explicit activity signal from the
        // extension (this window came to the foreground). Never reaches tmux;
        // it only marks this client most-recently-active for size ownership.
        if (msg.type === "client.focus") {
          sizeOwnership.noteActivity(clientKey);
          return;
        }

        // D4 mechanism (frozen) + tc-76m8.3 POLICY: the size OWNER's resize
        // drives `refresh-client -C`; a non-owner's is dropped. WHO owns is no
        // longer the static `ignore-size` flag — it follows activity
        // (window-size-`latest`). Record this client's latest desired viewport
        // regardless of ownership (a non-owner that later wins must have its
        // size re-applied so tmux reflows to it), then gate on current owner.
        if (msg.type === "resize.request") {
          lastResizeByClient.set(clientKey, msg as ResizeRequestMessage);
          if (!sizeOwnership.isSizeOwner(clientKey)) {
            return;
          }
        }

        // D4 (tc-4b6k.3): readOnly gate — observer clients must not send input
        // or issue mutating commands.  Drop input silently.
        if (msg.type === "input" && clientFlags?.readOnly === true) {
          return;
        }

        // tc-76m8.3 (S3): input is an activity signal — the human is typing
        // here, so (after debounce) this client owns the session size. Noted
        // AFTER the read-only drop: a read-only observer produces no input and
        // is not a size candidate anyway, but keeping the order explicit means
        // only delivered input counts. Falls through to handleClientMessage.
        if (msg.type === "input") {
          sizeOwnership.noteActivity(clientKey);
        }

        // tc-295a.11: pane.capture — one-shot pane text snapshot.
        // Handled here (not in input-path) because it:
        //   a) requires a directed command.response via the per-connection seq counter,
        //   b) must validate pane existence + REUSE captureText from hydration.ts,
        //   c) returns text in the payload, which does not fit input-path's fire-and-
        //      forget verb model (the response carries custom payload, not created ids).
        //
        // FAIL-LOUD: a vanished pane produces command.response { ok: false,
        // code: "pane.not-found" } — never a silent empty string.
        if (msg.type === "command.request" && msg.command.kind === "pane.capture") {
          const req = msg as import("@tmuxcc/protocol").SessionProxyCommandRequestMessage;
          const captureCmd = req.command as import("@tmuxcc/protocol").PaneCaptureCommand;
          const pid = captureCmd.paneId;

          // Model check: fail-loud if the pane is not present.
          if (!pipeline.getModel().panes.has(pid)) {
            server.sendCommandError(
              transport,
              req.correlationId,
              "pane.not-found",
              `Pane ${pid as string} is not present in the session model.`,
            );
            return;
          }

          // Capture via the same capturePane machinery the hydration path uses.
          void captureText(pipeline, pid).then((result) => {
            if (!result.ok) {
              // Pane vanished between the model check and the capture reply.
              server.sendCommandError(
                transport,
                req.correlationId,
                "pane.not-found",
                `Pane ${pid as string} could not be captured (it may have closed mid-request).`,
              );
              return;
            }
            server.sendCommandResponse(transport, req.correlationId, { text: result.text });
          });
          return;
        }

        // tc-x6l: session-proxy.info — read-only diagnostics command.
        // Handled here (not in input-path) because it requires sending a
        // directed response using the per-connection seq counter.
        if (msg.type === "command.request" && msg.command.kind === "session-proxy.info") {
          const correlationId = (msg as import("@tmuxcc/protocol").SessionProxyCommandRequestMessage).correlationId;
          // tc-3si.5: refresh the correlator's pending-slot age gauge
          // RIGHT BEFORE the exposition is rendered. The gauge is written
          // synchronously on every register/close edge, but the OLDEST
          // slot's age grows continuously while the queue is non-empty,
          // so this is the cheapest way to keep the exposition fresh
          // without a polling timer.
          pipeline.refreshCorrelatorPendingGauge();
          void metricsRegistry.metrics().then((metricsText) => {
            const breakdown = stormAlarm.windowBreakdown();
            const breakdownObj: Record<string, number> = {};
            for (const [k, v] of breakdown) {
              breakdownObj[k] = v;
            }
            server.sendCommandResponse(transport, correlationId, {
              info: {
                metricsText,
                stormWindowTotal: stormAlarm.windowTotal(),
                stormWindowBreakdown: breakdownObj,
                stormThreshold: stormAlarm.threshold,
                // D2 (tc-4b6k.1): the durable identity each connected client
                // presented at handshake. Observability only.
                clients: server.connectedClientIdentities(),
              },
            });
          });
          return;
        }

        // D4 (tc-4b6k.3): readOnly gate for mutating command.request verbs.
        // pane.capture and session-proxy.info are read-only queries already
        // handled above; all other command.request verbs cause tmux mutations
        // and are rejected for read-only clients.
        if (msg.type === "command.request" && clientFlags?.readOnly === true) {
          const req = msg as import("@tmuxcc/protocol").SessionProxyCommandRequestMessage;
          server.sendCommandError(
            transport,
            req.correlationId,
            "read-only",
            "Client is read-only: mutating commands are not allowed.",
          );
          return;
        }

        // tc-u7cu.6: close-cause pre-capture for close-pane and kill-window.
        //
        // When a close-pane or kill-window verb ACKs (%end), we record the
        // affected pane id(s) in closeCauses so the resulting pane.closed delta
        // is stamped with the cause (killed-by-this-connection). We capture the
        // id(s) HERE (from the command message, before handleClientMessage) so
        // the VerbResponder closure can reference them without needing to inspect
        // the model at ACK time.
        //
        // For kill-window we snapshot the current model's panes for that window
        // synchronously (before the command is sent). The %end arrives before
        // the topology requery, so the panes are still in the model at this
        // point — this is the correct snapshot window.
        //
        // We capture the connectionId here too (synchronously), so the closure
        // doesn't need to call server.connectionIdFor again at ACK time.
        let closeCauseCapture: (() => void) | undefined;
        if (msg.type === "command.request") {
          const cmd = (msg as import("@tmuxcc/protocol").SessionProxyCommandRequestMessage).command;
          const connId = server.connectionIdFor(transport);
          if (connId !== undefined) {
            if (cmd.kind === "close-pane") {
              const pid = (cmd as import("@tmuxcc/protocol").ClosePaneCommand).paneId;
              const reqId = (msg as import("@tmuxcc/protocol").SessionProxyCommandRequestMessage).correlationId;
              closeCauseCapture = () => closeCauses.record(pid, connId, reqId);
            } else if (cmd.kind === "kill-window") {
              const wid = (cmd as import("@tmuxcc/protocol").KillWindowCommand).windowId;
              const reqId = (msg as import("@tmuxcc/protocol").SessionProxyCommandRequestMessage).correlationId;
              // Snapshot which panes belong to this window RIGHT NOW (synchronous,
              // before the command is issued). This is safe because %end arrives
              // before the topology requery (tmux sends %end for a command
              // before emitting the corresponding topology notifications).
              const affectedPanes: import("@tmuxcc/protocol").PaneId[] = [];
              for (const pane of pipeline.getModel().panes.values()) {
                if (pane.windowId === wid) {
                  affectedPanes.push(pane.paneId);
                }
              }
              closeCauseCapture = () => {
                for (const pid of affectedPanes) {
                  closeCauses.record(pid, connId, reqId);
                }
              };
            }
          }
        }

        // tc-ozk.1: pane/window-creating verbs RETURN their effect ids. Bind a
        // per-transport responder that delivers the VerbResult as a
        // command.response (ok=true with the created ids, or ok=false on a
        // tmux %error / unparseable -P body). The success-path ids land in the
        // payload's paneId/windowId; the host binds by those ids when the pane
        // materialises — no observer/claim correlation needed.
        inputPath.handleClientMessage(
          msg as import("@tmuxcc/protocol").ClientMessage,
          (correlationId, result) => {
            if (result.ok) {
              if (result.newPaneId !== undefined && result.newWindowId !== undefined) {
                // tc-ozk.2: record the verb→effect-ids correlation BEFORE sending
                // the response, so the daemon can stamp `origin` on the
                // pane.opened / window.added it emits for these ids. connectionId
                // names THIS connection (the verb's issuer); requestId is the
                // verb's correlationId. The pane's delta may arrive before or
                // after this responder fires — the registry decouples them (a
                // late delta is emitted untagged but still bound by id, tc-ozk.1).
                const connId = server.connectionIdFor(transport);
                if (connId !== undefined) {
                  verbOrigins.record(result.newPaneId, result.newWindowId, connId, correlationId);
                }
                // Creating verb: include effect ids in the response payload.
                server.sendCommandResponse(transport, correlationId, {
                  paneId: result.newPaneId,
                  windowId: result.newWindowId,
                });
              } else {
                // tc-u7cu.3: Non-creating verb ACK — no effect ids to record or
                // send.  The client receives { ok: true, payload: {} } which it
                // resolves as a simple success (VerbResult { ok: true }).
                //
                // tc-u7cu.6: if this was a close-pane or kill-window verb, record
                // the close cause now that tmux has ACKed (%end). The %end always
                // arrives before the topology requery in tmux control mode, so
                // the pane.closed delta has not yet been emitted.
                closeCauseCapture?.();
                server.sendCommandResponse(transport, correlationId, {});
              }
            } else {
              server.sendCommandError(transport, correlationId, result.code, result.message);
            }
          },
          // tc-4b6k.2 (D3): key per-client writes (binding intent) to the
          // ISSUING connection's durable identity, so `set-object-policy bound`
          // lands in THIS client's own `@tmuxcc-bound-<key>` slot.
          server.clientIdentityFor(transport)?.id,
        );
      });

      // 4. Clean up data plane when the transport closes.
      transport.onClose(() => {
        // tc-76m8.27: flip BEFORE removeClient so the deferred drain credits
        // this close releases (they run as microtasks after these synchronous
        // handlers) see the flag and drop — see the drainingTransport comment.
        closed = true;
        detach();
        // tc-0wtb: drop this client's FC-1 sub-ledger and re-evaluate every
        // paused pane's max. Detaching the slowest consumer can itself drop the
        // max to/below low-water and resume the pane for the remaining clients.
        fc.removeClient(transport);
        // tc-76m8.3: drop this client from size-ownership. If it was the owner,
        // ownership hands off immediately (no debounce) to the most-recently
        // active remaining candidate, which re-applies that client's viewport.
        sizeOwnership.removeClient(clientKey);
        lastResizeByClient.delete(clientKey);
        server.removeClient(transport);
      });

      return session;
    },

    send(command: string): Promise<CommandResult> {
      return pipeline.send(command);
    },

    hydrateClient(transport: Transport): Promise<void> {
      // tc-5quo: public entry point — drives the same hydration helper used
      // by addClient.  Tests use this to drive the hydration round-trip
      // directly against a recording transport without re-running the
      // handshake.
      //
      // tc-295a.9: frame each pane with sentinels too. The transport passed
      // here is the bare client transport (not the demux-attached draining
      // wrapper), so the queue gate is a no-op unless the same object was
      // attached via demux.attachTransport — fine for the test driver, which
      // exercises the sentinel emissions, not the live-byte queue.
      const sentinels = makeSentinels(transport, transport);
      return hydrateTransport(pipeline, transport, pipeline.getModel().panes.keys(), sentinels);
    },

    stop(): Promise<void> {
      stormAlarm.stop();
      metricsRegistry.stop();
      pipeline.stop();
      sizeOwnership.dispose();
      return host.stop();
    },

    kill(): void {
      stormAlarm.stop();
      metricsRegistry.stop();
      pipeline.stop();
      sizeOwnership.dispose();
      host.kill();
    },
  };

  // tc-fah2: test seam — expose _paneExitHeadedCascade for EB8/DS tests so
  // they can verify the flag transitions (pane count 0 → true; back to >0 → false).
  // Non-enumerable, not in SessionProxy interface.
  // Tests access via: (proxy as any)._paneExitHeadedCascadeForTesting
  Object.defineProperty(sessionProxyHandle, "_paneExitHeadedCascadeForTesting", {
    get: () => _paneExitHeadedCascade,
    enumerable: false,
    configurable: false,
  });

  return sessionProxyHandle;
}
