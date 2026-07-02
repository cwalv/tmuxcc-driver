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

import type { Transport, NegotiatedSession, PaneId, WireCommand, ClientIdentity } from "@tmuxcc/session-proxy";
import { SessionProxyConnection } from "./connection.js";
import { Mirror } from "./mirror.js";
import { PaneStreamConsumer, connectPaneStream } from "./pane-stream.js";
import { createInputApi } from "./input.js";
import type { InputApiOptions, VerbResult } from "./input.js";
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
  /**
   * Durable client identity to present at handshake (D2, tc-4b6k.1). Forwarded
   * to the underlying {@link SessionProxyConnection} so it is advertised on
   * `client.capabilities` for the session-proxy wire. Omit for an anonymous
   * connection. Carried and logged only — no behavior depends on it yet.
   */
  identity?: ClientIdentity;
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
 *     session-proxy.
 *   - `mirror` is initialized from the session-proxy's snapshot.
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
   * The mirror — initialized from the session-proxy snapshot.
   * Call `mirror.attach(hook)` to catch up and subscribe.
   */
  readonly mirror: Mirror;

  /**
   * The negotiated session (protocolVersion, features).
   */
  readonly session: NegotiatedSession;

  /**
   * Send a pane/window-CREATING verb and await its effect ids (tc-ozk.1).
   *
   * Resolves with `{ ok: true, newPaneId, newWindowId }` carrying the ids tmux
   * actually created, or `{ ok: false, code, message }` on a tmux `%error`.
   * The caller binds by the returned ids the moment the pane materialises — no
   * observer/claim correlation needed (the reply may arrive before OR after the
   * pane's `pane.opened` delta; binding is by id, not by ordering).
   *
   * Rejects only if the connection closes before the response arrives.
   */
  sendVerb(cmd: WireCommand): Promise<VerbResult>;

  /**
   * Send a `pane.capture` wire command and await the captured text
   * (tc-295a.17 / E3.2).
   *
   * Issues `{ kind: "pane.capture", paneId }` as a correlated command request
   * and resolves with the full UTF-8 scrollback text when the session-proxy
   * replies with `result.ok = true`.
   *
   * Rejects (fail-loud) when the session-proxy returns `result.ok = false`
   * (e.g. code `"pane.not-found"`) or the connection closes before the
   * response arrives.
   */
  capturePane(paneId: PaneId): Promise<string>;

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
 * Connect to a session-proxy via the given transport and return a fully-built handle.
 *
 * Builds:
 *   - SessionProxyConnection  (over `transport`)
 *   - Mirror            (wired to connection.onControl via connectTo)
 *   - PaneStreamConsumer (wired to connection.onData via connectPaneStream)
 *   - InputApi          (wired to connection.send)
 *   - ClientController  (delegates to InputApi)
 *
 * Runs the wire handshake and waits for the session-proxy snapshot before resolving.
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

  const connection = new SessionProxyConnection(
    transport,
    opts.identity !== undefined ? { identity: opts.identity } : undefined,
  );
  const mirror = new Mirror();
  const paneConsumer = new PaneStreamConsumer();
  const inputApi = createInputApi(connection, opts.input);

  // ── Run the wire handshake ──────────────────────────────────────────────────

  const session = await connection.connect();

  // ── Wire modules to the live connection ────────────────────────────────────

  // Wire mirror to the connection's control stream.
  // Must be called AFTER connect() so buffered messages are delivered.
  // p8lh: KEEP the unsubscribe — disconnect() calls it to sever the mirror from
  // the connection (no-op the onControl handler + clear the mirror's injected
  // send/close fns).  Otherwise a control delta arriving AFTER close() routes
  // into the still-wired mirror, trips seq-gap detection, and fires a
  // `resync.request` send() on the CLOSED connection → the p8lh send-on-closed
  // throw (the second, resync-driven path of this flake).
  const detachMirrorFromConnection = mirror.connectTo(connection);

  // tc-ozk.1: route command.response messages from the mirror's control stream
  // to the InputApi so awaited sendVerb() promises resolve with the returned
  // effect ids.  The mirror owns the single-slot onControl handler; this is the
  // forwarding seam.
  mirror.onCommandResponse((msg) => inputApi.handleCommandResponse(msg));

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
    attachPane(paneId: PaneId): void {
      inputApi.attachPane(paneId);
    },
  };

  // ── disconnect() ────────────────────────────────────────────────────────────

  let _disconnected = false;

  function disconnect(): void {
    if (_disconnected) return;
    _disconnected = true;
    // tc-ozk.1: fail any in-flight sendVerb() / sendPaneCapture() awaits so callers don't hang.
    inputApi.rejectAllPending("connection disconnected before verb response arrived");
    // p8lh: stop BOTH deferred/event-driven sends that could otherwise fire
    // send() on the about-to-close connection and throw a floating unhandled
    // rejection (the cross-spec flake that fails whichever test/turn is active):
    //   (a) the coalesced-resize microtask — markDisconnected() drains the
    //       pending resize, disarms the scheduled flush, AND no-ops any LATER
    //       resizePane (VS Code fires setDimensions asynchronously during
    //       teardown), so no obsolete resize is ever sent on the dead connection;
    //   (b) the mirror's resync.request — severing the mirror from the
    //       connection no-ops its onControl handler and clears its injected
    //       send/close fns, so a post-close control delta can't trip seq-gap
    //       detection into a send() on the closed connection.
    // Both are obsolete-by-disconnect; we STOP the illegal sends, the
    // close-state send() tripwire stays intact for any real caller.
    inputApi.markDisconnected();
    detachMirrorFromConnection();
    mirror.detachHook();
    connection.close();
  }

  // ── Return fully-built handle ───────────────────────────────────────────────

  return {
    controller,
    mirror,
    session,
    sendVerb: (cmd: WireCommand) => inputApi.sendVerb(cmd),
    capturePane: (paneId: PaneId) => inputApi.sendPaneCapture(paneId),
    disconnect,
  };
}
