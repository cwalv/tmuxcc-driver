/**
 * createDaemon — assemble the full daemon runtime from its component parts (tc-93a).
 *
 * This is the canonical "wire everything together" entry point for the E4
 * daemon runtime.  It mirrors what createClient() does on the client side:
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
 * @module runtime/daemon
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
import type { PaneId } from "../wire/ids.js";
import type { PaneBufferStore } from "../state/reducer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for createDaemon. Each sub-group maps to the respective component. */
export interface DaemonOptions {
  /** Options forwarded to createTmuxHost (socketName, sessionName, cols/rows, …). */
  host?: TmuxHostOptions;
  /** Options forwarded to createControlServer (capabilities override). */
  server?: ControlServerOptions;
  /** Options forwarded to createInputPath (id-mapping overrides). */
  input?: InputPathOptions;
  /** Options forwarded to createFlowController (highWaterBytes / lowWaterBytes). */
  flow?: FlowControllerOptions;
}

/**
 * A fully-assembled daemon runtime.
 *
 * Call `start()` to spawn tmux and bootstrap the pipeline.
 * Call `addClient(transport)` for each new client connection.
 * Call `stop()` / `kill()` for shutdown.
 */
export interface Daemon {
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
   * Start the daemon: spawn tmux and run the bootstrap exchange.
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
 * Assemble the full daemon runtime.
 *
 * The returned Daemon is NOT started yet — call `daemon.start()` to spawn tmux.
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
export function createDaemon(opts: DaemonOptions = {}): Daemon {
  // 1. Host
  const host = createTmuxHost(opts.host);

  // 2. Demux
  const demux = createOutputDemux();

  // 3. Flow controller — needs host + demux; pipeline not yet created.
  const fc = createFlowController(host, demux, opts.flow);

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

  // 5. Pipeline — uses the accounting (wrapped demux) store.
  const pipeline = createRuntimePipeline(host, { buffers: accountingStore });

  // 6. Control-plane server.
  const server = createControlServer(pipeline, opts.server);

  // 7. Input path.
  const inputPath = createInputPath(host, opts.input);

  // ---------------------------------------------------------------------------
  // Daemon handle
  // ---------------------------------------------------------------------------

  return {
    host,
    demux,
    pipeline,
    server,
    inputPath,
    flowController: fc,

    async start(): Promise<void> {
      await host.start();
      await pipeline.start();
    },

    async addClient(transport: Transport) {
      // 1. Run control-plane handshake + send snapshot + subscribe deltas.
      const session = await server.addClient(transport);

      // 2. Wire data plane: attach demux fan-out to this transport.
      const detach = demux.attachTransport(transport);

      // 3. Wire input path: forward client control messages to tmux.
      transport.onControl((msg) => {
        inputPath.handleClientMessage(msg as import("../wire/control.js").ClientMessage);
      });

      // 4. Clean up data plane when the transport closes.
      transport.onClose(() => {
        detach();
        server.removeClient(transport);
      });

      return session;
    },

    stop(): Promise<void> {
      pipeline.stop();
      return host.stop();
    },

    kill(): void {
      pipeline.stop();
      host.kill();
    },
  };
}
