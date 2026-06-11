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
 *         → host.write (send-keys / refresh-client)
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
import type { TmuxHost, TmuxHostOptions } from "./tmux-host.js";
import { createOutputDemux } from "./output-demux.js";
import type { OutputDemux } from "./output-demux.js";
import { createRuntimePipeline } from "./pipeline.js";
import type { RuntimePipeline } from "./pipeline.js";
import { createControlServer } from "./serve.js";
import type { ControlServer, ControlServerOptions } from "./serve.js";
import { createInputPath } from "./input-path.js";
import type { InputPath, InputPathOptions } from "./input-path.js";
import { createFlowController } from "./flow-control.js";
import type { FlowController, FlowControllerOptions } from "./flow-control.js";
import type { Transport } from "../wire/transport.js";
import { paneId as mintPaneId } from "../wire/ids.js";
import type { PaneId } from "../wire/ids.js";
import type { PaneBufferStore } from "../state/scrollback.js";
import type { SwitchClientOutcome } from "../state/switch-client.js";
import { createSessionProxyRegistry, createStormAlarm } from "../metrics/index.js";
import type { SessionProxyRegistry, StormAlarmOptions } from "../metrics/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
}

/**
 * A fully-assembled session-proxy runtime.
 *
 * Call `start()` to spawn tmux and bootstrap the pipeline.
 * Call `addClient(transport)` for each new client connection.
 * Call `stop()` / `kill()` for shutdown.
 */
export interface SessionProxy {
  /** The underlying TmuxHost (useful for direct write() in tests). */
  readonly host: TmuxHost;
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
   * Returns the NegotiatedSession from the handshake.
   */
  addClient(transport: Transport): Promise<import("../wire/handshake.js").NegotiatedSession>;

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

  // 1. Host
  const host = createTmuxHost(opts.host);

  // 2. Demux
  const demux = createOutputDemux();

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
  const fc = createFlowController(fcSend, demux, opts.flow);

  // 4. Wrap the demux store so the flow controller is notified of every append.
  //    The wrapper delegates everything to demux.store and additionally calls
  //    fc.onPaneBytes so backpressure accounting stays accurate.
  const accountingStore: PaneBufferStore = {
    append(paneId: PaneId, bytes: Uint8Array): void {
      demux.store.append(paneId, bytes);
      if (bytes.length > 0) {
        fc.onPaneBytes(paneId, bytes.length);
      }
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

  const pipeline = createRuntimePipeline(host, {
    buffers: accountingStore,
    sessionName: opts.host.sessionName,
    // tc-x6l: per-kind counters + storm alarm attach to the topology
    // classification choke point — the coalescer's onNotify path, surfaced
    // through this pipeline option. The hook only fires for topology-
    // classified notifications (output/pause/continue and the optimistic
    // internal:* events never count); the storm alarm and counters only
    // care about topology rate, so this is the right scope.
    onTopologyNotify: (kind) => {
      metricsRegistry.incTopologyEvent(kind);
      stormAlarm.record(kind);
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
  //     writeCommand seam (and the switch-client attach-session writer
  //     installed in step 5) can reach the pipeline now that it exists. Both
  //     callsites only fire after pipeline.start() resolves, so the slot/write
  //     wiring is always live by then.
  pipelineRef = pipeline;

  // 6. Control-plane server.
  const server = createControlServer(pipeline, opts.server);

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
  pipeline.onNotification((event) => {
    if (event.kind === "pause") {
      fc.onPauseNotification(mintPaneId("p" + event.paneId));
    } else if (event.kind === "continue") {
      fc.onContinueNotification(mintPaneId("p" + event.paneId));
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
      }
    }
  });

  // ---------------------------------------------------------------------------
  // SessionProxy handle
  // ---------------------------------------------------------------------------

  return {
    host,
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

      // Subscribe to host.onExit so that when tmux dies unexpectedly the
      // session-proxy tears down its pipeline and notifies all connected clients.
      host.onExit(() => {
        // Stop the pipeline (mirrors stop() but without waiting for host exit
        // since we're already in the exit handler).
        pipeline.stop();

        // Push session.unavailable to every connected client so they know the
        // session is gone and should treat the connection as dead.
        server.broadcastError({
          type: "error",
          code: "session.unavailable",
          message: "The tmux session has exited unexpectedly.",
        });
      });
    },

    async addClient(transport: Transport) {
      // 1. Run control-plane handshake + send snapshot + subscribe deltas.
      const session = await server.addClient(transport);

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
      //    We wrap only sendData; all other Transport methods are forwarded
      //    unchanged so the demux sees a fully-conforming Transport.
      const drainingTransport: Transport = {
        ...transport,
        sendData(pid: PaneId, bytes: Uint8Array): void | Promise<void> {
          const result = transport.sendData(pid, bytes);
          if (bytes.length === 0) return result;
          // Promise<void>: transport is backpressured; defer the drain credit
          // until the underlying socket reports drain.
          if (result !== undefined && typeof (result as Promise<void>).then === "function") {
            return (result as Promise<void>).then(() => {
              fc.noteDrained(pid, bytes.length);
            });
          }
          // void: kernel send buffer accepted the bytes immediately.  Credit
          // drain synchronously — there's no further wait.
          fc.noteDrained(pid, bytes.length);
          return undefined;
        },
      };
      const detach = demux.attachTransport(drainingTransport);

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

        // tc-x6l: session-proxy.info — read-only diagnostics command.
        // Handled here (not in input-path) because it requires sending a
        // directed response using the per-connection seq counter.
        if (msg.type === "command.request" && msg.command.kind === "session-proxy.info") {
          const correlationId = (msg as import("../wire/session-proxy-control.js").SessionProxyCommandRequestMessage).correlationId;
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
              },
            });
          });
          return;
        }

        inputPath.handleClientMessage(msg as import("../wire/session-proxy-control.js").ClientMessage);
      });

      // 4. Clean up data plane when the transport closes.
      transport.onClose(() => {
        detach();
        server.removeClient(transport);
      });

      return session;
    },

    stop(): Promise<void> {
      stormAlarm.stop();
      metricsRegistry.stop();
      pipeline.stop();
      return host.stop();
    },

    kill(): void {
      stormAlarm.stop();
      metricsRegistry.stop();
      pipeline.stop();
      host.kill();
    },
  };
}
