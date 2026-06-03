/**
 * connectClient — top-level integration wiring for the headless client.
 *
 * Assembles the five E5 modules (connection, mirror, pane-stream, input,
 * render-hook driver) into one coherent client handle:
 *
 * ```ts
 * const handle = await connectClient(transport);
 * // handle = { controller, mirror, session, disconnect }
 * // All four fields are real and usable. No placeholder, no late assignment.
 *
 * const hook = new VsCodeRenderHook(factory, logger, handle.controller);
 * handle.mirror.attach(hook);
 * // attach walks the current mirror state (sessions, windows, panes) firing
 * // onWindowAdded / onPaneOpened / onFocusChanged for each existing entity,
 * // then subscribes to deltas. No separate 'snapshot replay' special case.
 * ```
 *
 * # NO DOM, NO vscode, NO host API, NO Pseudoterminal
 */

import type { Transport, NegotiatedSession, PaneId, WireCommand } from "@tmuxcc/daemon";
import { DaemonConnection } from "./connection.js";
import { Mirror } from "./mirror.js";
import { PaneStreamConsumer, connectPaneStream } from "./pane-stream.js";
import { createInputApi } from "./input.js";
import type { InputApiOptions } from "./input.js";
import type {
  ClientController,
  ByteSource,
} from "./render-hook.js";

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
// connectClient options
// ---------------------------------------------------------------------------

/**
 * Options for connectClient.
 */
export interface ConnectClientOptions {
  /**
   * Input API options (coalesce resize, etc.).
   * @see InputApiOptions
   */
  input?: InputApiOptions;
}

// ---------------------------------------------------------------------------
// ClientHandle — the fully-built handle returned by connectClient
// ---------------------------------------------------------------------------

/**
 * The fully-built handle returned by connectClient.
 *
 * All four fields are real and usable immediately — no placeholder, no late
 * assignment.  After `await connectClient(transport)` resolves:
 *   - `controller.sendInput` / `resizePane` / `sendCommand` are wired to the
 *     daemon.
 *   - `mirror` is initialized from the daemon's snapshot.
 *   - `session` contains the negotiated protocol version + features.
 *   - `disconnect()` tears down byte subscriptions, detaches the hook, and
 *     closes the transport.
 *
 * Hook attachment is separate and idempotent:
 * ```ts
 * const hook = new MyHook(handle.controller);
 * handle.mirror.attach(hook);
 * ```
 */
export interface ClientHandle {
  /**
   * The controller the renderer uses to send input and resize requests.
   * Available immediately — no connect() step required.
   */
  readonly controller: ClientController;

  /**
   * The mirror — initialized from the daemon snapshot.
   * Call `mirror.attach(hook)` to catch up and subscribe.
   */
  readonly mirror: Mirror;

  /**
   * The negotiated session (protocolVersion, features).
   */
  readonly session: NegotiatedSession;

  /**
   * Detach the render hook (if any), close the connection, and tear down all
   * subscriptions.  Safe to call more than once.
   */
  disconnect(): void;
}

// ---------------------------------------------------------------------------
// connectClient
// ---------------------------------------------------------------------------

/**
 * Connect to a daemon via the given transport and return a fully-built handle.
 *
 * Builds:
 *   - DaemonConnection  (over `transport`)
 *   - Mirror            (wired to connection.onControl via connectTo)
 *   - PaneStreamConsumer (wired to connection.onData via connectPaneStream)
 *   - InputApi          (wired to connection.send)
 *   - ClientController  (delegates to InputApi)
 *
 * Runs the wire handshake and waits for the daemon snapshot before resolving.
 * After this promise resolves, `handle.mirror` is initialized and
 * `handle.controller` is usable.
 *
 * @param transport - Injected wire transport.  Caller owns creation; the
 *                    returned handle owns lifecycle after this point
 *                    (disconnect() closes it).
 * @param opts      - Optional tuning (InputApiOptions, etc.).
 */
export async function connectClient(
  transport: Transport,
  opts: ConnectClientOptions = {},
): Promise<ClientHandle> {
  // ── Construct modules ────────────────────────────────────────────────────────

  const connection = new DaemonConnection(transport);
  const mirror = new Mirror();
  const paneConsumer = new PaneStreamConsumer();
  const inputApi = createInputApi(connection, opts.input);

  // ── Run the wire handshake ──────────────────────────────────────────────────

  const session = await connection.connect();

  // ── Wire modules to the live connection ────────────────────────────────────

  // Wire mirror to the connection's control stream.
  // Must be called AFTER connect() so buffered messages are delivered.
  mirror.connectTo(connection);

  // Wire the pane-stream consumer to the connection's data stream.
  connectPaneStream(connection, paneConsumer);

  // Pre-wire the byte source into the mirror so mirror.attach(hook) works.
  mirror.wireDataSources(consumerToByteSource(paneConsumer));

  // ── Build the controller ────────────────────────────────────────────────────

  const controller: ClientController = {
    sendInput(paneId: PaneId, data: string): void {
      inputApi.sendInput(paneId, data);
    },
    resizePane(paneId: PaneId, cols: number, rows: number): void {
      inputApi.resizePane(paneId, cols, rows);
    },
    sendCommand(cmd: WireCommand): void {
      inputApi.sendCommand(cmd);
    },
  };

  // ── disconnect() ────────────────────────────────────────────────────────────

  let _disconnected = false;

  function disconnect(): void {
    if (_disconnected) return;
    _disconnected = true;
    mirror.detachHook();
    connection.close();
  }

  // ── Return fully-built handle ───────────────────────────────────────────────

  return { controller, mirror, session, disconnect };
}
