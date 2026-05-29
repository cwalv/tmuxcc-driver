/**
 * createClient — top-level integration wiring for the headless client.
 *
 * Assembles the five E5 modules (connection, mirror, pane-stream, input,
 * render-hook driver) into one coherent client object and adapts the concrete
 * module APIs to the abstract ModelSource / ByteSource / InputSink seams that
 * createRenderHookDriver expects.
 *
 * # Adapter notes (mismatch bridging)
 *
 * ## ModelSource.getModel() shape mismatch
 *
 * render-hook.ts defines a LOCAL ClientModel with:
 *   panes: ReadonlyMap<PaneId, PaneInfo>          (PaneInfo has `active` not `mode`)
 *   windows: ReadonlyMap<WindowId, WindowInfo>    (WindowInfo has no `layout`)
 *   focus: FocusInfo
 *
 * mirror.ts defines its own ClientModel with:
 *   panes: ReadonlyMap<PaneId, ClientPane>        (ClientPane has `mode` not `active`)
 *   windows: ReadonlyMap<WindowId, ClientWindow>  (ClientWindow has `layout`)
 *   focus: ClientFocus
 *
 * These are structurally different.  The adapter (mirrorToModelSource) maps:
 *   - ClientPane → PaneInfo: paneId, windowId, sessionId, cols, rows are direct;
 *     `active` is derived from mirror.getModel().focus.paneId === pane.paneId.
 *   - ClientWindow → WindowInfo: windowId, sessionId, name, active are direct;
 *     `layout` is dropped (WindowInfo has no layout field).
 *   - ClientFocus → FocusInfo: direct (same shape).
 *
 * ## ModelSource.onModelChange signature mismatch
 *
 * render-hook.ts:  onModelChange(callback: () => void): () => void
 * mirror.ts:       onModelChange(handler: (model: ClientModel) => void): () => void
 *
 * The mirror's handler receives the new model as an argument; the driver's
 * callback takes no arguments.  The adapter wraps the driver's zero-arg callback
 * in a one-arg lambda that ignores the model parameter — structurally compatible.
 *
 * ## ByteSource / InputSink
 *
 * PaneStreamConsumer.onPaneOutput(paneId, handler) → () => void matches
 * ByteSource.onPaneOutput exactly — no adapter needed, pass through directly.
 *
 * InputApi (sendInput, resizePane) matches InputSink exactly — pass through.
 *
 * # E6 usage
 *
 * ```ts
 * const { daemon, client: transport } = createInMemoryTransportPair();
 * // or: const transport = createPipeTransport(socketPath);
 *
 * const hook: RenderHook = myVsCodeRenderer;
 * const client = createClient(transport, hook);
 * const session = await client.connect();    // runs handshake
 * // hook.onConnected() fires, hook.onPaneOpened() etc. fire with initial state
 *
 * client.controller.sendInput(paneId("p0"), "ls\r");
 * client.controller.resizePane(paneId("p0"), 220, 50);
 *
 * client.stop();   // detaches render-hook driver, closes connection
 * ```
 *
 * # NO DOM, NO vscode, NO host API, NO Pseudoterminal
 */

import type { Transport, NegotiatedSession, PaneId, WindowId } from "@tmuxcc/daemon";
import { DaemonConnection } from "./connection.js";
import { Mirror } from "./mirror.js";
import type { ClientPane, ClientWindow, ClientFocus } from "./mirror.js";
import { PaneStreamConsumer, connectPaneStream } from "./pane-stream.js";
import { createInputApi } from "./input.js";
import type { InputApiOptions } from "./input.js";
import {
  createRenderHookDriver,
} from "./render-hook.js";
import type {
  RenderHook,
  ClientController,
  ModelSource,
  ByteSource,
  InputSink,
  ClientModel as RenderClientModel,
  PaneInfo,
  WindowInfo,
  FocusInfo,
} from "./render-hook.js";

// ---------------------------------------------------------------------------
// Adapter: Mirror → ModelSource
// ---------------------------------------------------------------------------

/**
 * Adapt a Mirror instance to the ModelSource interface expected by
 * createRenderHookDriver.
 *
 * Bridges two mismatches:
 *   1. Model shape: Mirror's ClientModel uses ClientPane/ClientWindow;
 *      the driver's ClientModel uses PaneInfo/WindowInfo (different field sets).
 *   2. onModelChange callback arity: Mirror passes (model) to the handler;
 *      the driver expects () => void.  We wrap and ignore the arg.
 */
function mirrorToModelSource(mirror: Mirror): ModelSource {
  return {
    getModel(): RenderClientModel {
      const m = mirror.getModel();
      // Map ClientPane → PaneInfo.
      // PaneInfo.active = (pane is the focused pane in the current focus triple).
      const focusPaneId = m.focus.paneId;
      const panes = new Map<PaneId, PaneInfo>();
      for (const [id, p] of m.panes) {
        panes.set(id, {
          paneId: p.paneId,
          windowId: p.windowId,
          sessionId: p.sessionId,
          cols: p.cols,
          rows: p.rows,
          active: p.paneId === focusPaneId,
        });
      }

      // Map ClientWindow → WindowInfo.
      // WindowInfo has no layout field; drop it.
      const windows = new Map<WindowId, WindowInfo>();
      for (const [id, w] of m.windows) {
        windows.set(id, {
          windowId: w.windowId,
          sessionId: w.sessionId,
          name: w.name,
          active: w.active,
        });
      }

      const focus: FocusInfo = {
        paneId: m.focus.paneId,
        windowId: m.focus.windowId,
        sessionId: m.focus.sessionId,
      };

      return { panes, windows, focus };
    },

    onModelChange(callback: () => void): () => void {
      // Mirror's onModelChange passes the new model to the handler, but the
      // driver only needs a zero-arg notification.  Wrap and ignore the arg.
      return mirror.onModelChange((_model) => callback());
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter: PaneStreamConsumer → ByteSource
// ---------------------------------------------------------------------------

/**
 * Adapt a PaneStreamConsumer to the ByteSource interface.
 *
 * PaneStreamConsumer.onPaneOutput(paneId, handler) → () => void is already an
 * exact structural match for ByteSource.onPaneOutput — no translation needed.
 * We wrap it as a plain object conforming to the interface.
 */
function consumerToByteSource(consumer: PaneStreamConsumer): ByteSource {
  return {
    onPaneOutput(paneId: PaneId, callback: (bytes: Uint8Array) => void): () => void {
      return consumer.onPaneOutput(paneId, callback);
    },
  };
}

// ---------------------------------------------------------------------------
// createClient options
// ---------------------------------------------------------------------------

/**
 * Options for createClient.
 */
export interface CreateClientOptions {
  /**
   * Input API options (coalesce resize, etc.).
   * @see InputApiOptions
   */
  input?: InputApiOptions;
}

// ---------------------------------------------------------------------------
// Client handle
// ---------------------------------------------------------------------------

/**
 * The handle returned by createClient.
 */
export interface ClientHandle {
  /**
   * Run the wire handshake with the daemon, initialise the mirror, subscribe
   * to byte streams, and start the render-hook driver.
   *
   * After this resolves:
   *   - The render hook has received onWindowAdded / onPaneOpened /
   *     onLayoutChanged / onFocusChanged for every entity in the snapshot,
   *     followed by onConnected().
   *   - controller.sendInput / resizePane are ready.
   *
   * Rejects with HandshakeError on protocol mismatch or transport failure.
   */
  connect(): Promise<NegotiatedSession>;

  /**
   * The controller the renderer uses to send input and resize requests.
   * Available only after connect() resolves.
   */
  readonly controller: ClientController;

  /**
   * Detach the render-hook driver, close the connection, and tear down all
   * subscriptions.  Safe to call more than once.
   */
  stop(): void;
}

// ---------------------------------------------------------------------------
// createClient
// ---------------------------------------------------------------------------

/**
 * Assemble the full headless client from a transport and a render hook.
 *
 * Builds:
 *   - DaemonConnection  (over `transport`)
 *   - Mirror            (wired to connection.onControl via connectTo)
 *   - PaneStreamConsumer (wired to connection.onData via connectPaneStream)
 *   - InputApi          (wired to connection.send)
 *   - createRenderHookDriver (adapted Mirror, Consumer, InputApi → abstract seams)
 *
 * @param transport - Injected wire transport.  Caller owns creation; createClient
 *                    owns lifecycle after this point (stop() closes it).
 * @param hook      - Renderer implementation of RenderHook.
 * @param opts      - Optional tuning (InputApiOptions, etc.).
 */
export function createClient(
  transport: Transport,
  hook: RenderHook,
  opts: CreateClientOptions = {},
): ClientHandle {
  // ── Construct modules ────────────────────────────────────────────────────────

  const connection = new DaemonConnection(transport);
  const mirror = new Mirror();
  const paneConsumer = new PaneStreamConsumer();
  const inputApi = createInputApi(connection, opts.input);

  // Build the render-hook driver (does not start yet).
  const driver = createRenderHookDriver(
    hook,
    mirrorToModelSource(mirror),
    consumerToByteSource(paneConsumer),
    inputApi as InputSink,
  );

  // Mutable controller slot — filled when connect() starts the driver.
  let _controller: ClientController = {
    sendInput(_paneId: PaneId, _data: string): void {
      throw new Error("createClient: call connect() before using the controller");
    },
    resizePane(_paneId: PaneId, _cols: number, _rows: number): void {
      throw new Error("createClient: call connect() before using the controller");
    },
    sendCommand(_cmd): void {
      throw new Error("createClient: call connect() before using the controller");
    },
  };

  let _stop: (() => void) | null = null;
  let _stopped = false;

  // ── connect() ───────────────────────────────────────────────────────────────

  async function connect(): Promise<NegotiatedSession> {
    // Run the wire handshake.
    const session = await connection.connect();

    // Wire mirror to the connection's control stream.
    // Must be called AFTER connect() so buffered messages are delivered.
    mirror.connectTo(connection);

    // Wire the pane-stream consumer to the connection's data stream.
    connectPaneStream(connection, paneConsumer);

    // Start the render-hook driver (fires initial onWindowAdded / onPaneOpened /
    // onFocusChanged / onConnected from the snapshot already in the mirror).
    const session_ = driver.start();
    _controller = session_.controller;
    _stop = () => {
      session_.stop();
      connection.close();
    };

    return session;
  }

  // ── stop() ──────────────────────────────────────────────────────────────────

  function stop(): void {
    if (_stopped) return;
    _stopped = true;
    if (_stop !== null) {
      _stop();
    } else {
      // connect() was never called — just close the transport.
      connection.close();
    }
  }

  // ── Public handle ────────────────────────────────────────────────────────────

  // Use a Proxy-like accessor for controller so callers can destructure it
  // before connect() and still get the live reference after connect().
  const handle: ClientHandle = {
    connect,
    get controller(): ClientController {
      return _controller;
    },
    stop,
  };

  return handle;
}
