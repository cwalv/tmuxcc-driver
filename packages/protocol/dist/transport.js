/**
 * Transport seam — the abstraction the wire protocol rides over.
 *
 * # Two-plane design
 *
 * The wire carries two logically distinct channels over a single transport
 * connection:
 *
 * ## Control plane (structured messages)
 *   Carries ControlMessage values — typed, JSON-serializable, low-volume.
 *   Examples: pane-lifecycle events, layout updates, input commands.
 *   The control plane is structured because these messages need to be
 *   inspected, logged, and routed by type.  JSON/text encoding is fine at
 *   the volumes involved.
 *
 * ## Data plane (raw byte frames)
 *   Carries terminal output bytes for a specific pane.  This is the hot path:
 *   a busy terminal can push megabytes per second.  Using JSON or base64 on
 *   this path would triple the bytes on the wire and add per-character parsing
 *   cost.  Instead, data-plane frames are raw Uint8Array chunks tagged only
 *   with a PaneId.  The framing format (length-prefix, etc.) is defined by
 *   bead tc-2mq; this seam only deals in decoded frames.
 *
 * # Why a seam?
 *
 * The Transport interface is implemented independently for each concrete
 * transport (the broker's production socket transport, and an in-process pair
 * for tests).  Wire-level code (sessionProxy, client, codec) depends only on
 * this interface so that the concrete transport can be swapped without changing
 * any wire logic.
 *
 * # Imports
 *   - ControlMessage  — from tc-auj (control schema bead)
 *   - PaneId          — from ids.ts (shared primitive, used by both planes)
 */
/**
 * Create a paired in-memory transport for testing session-proxy↔client interactions
 * without a real socket.
 *
 * Both endpoints start open.  Call `sessionProxy.close()` or `client.close()` to
 * tear down the pair; the close propagates to the remote endpoint's onClose
 * handler.
 */
export function createInMemoryTransportPair() {
    let sessionProxyControlHandler = null;
    let sessionProxyDataHandler = null;
    const sessionProxyCloseHandlers = new Set();
    let clientControlHandler = null;
    let clientDataHandler = null;
    const clientCloseHandlers = new Set();
    let closed = false;
    const sessionProxy = {
        sendControl(msg) {
            if (closed)
                return;
            clientControlHandler?.(msg);
        },
        onControl(handler) {
            sessionProxyControlHandler = handler;
        },
        sendData(paneId, bytes) {
            if (closed)
                return;
            clientDataHandler?.(paneId, bytes);
        },
        onData(handler) {
            sessionProxyDataHandler = handler;
        },
        onClose(handler) {
            sessionProxyCloseHandlers.add(handler);
            return () => { sessionProxyCloseHandlers.delete(handler); };
        },
        close(err) {
            if (closed)
                return;
            closed = true;
            // Notify the remote (client) side first, then self.
            for (const h of clientCloseHandlers)
                h(err);
            for (const h of sessionProxyCloseHandlers)
                h(err);
        },
    };
    const client = {
        sendControl(msg) {
            if (closed)
                return;
            sessionProxyControlHandler?.(msg);
        },
        onControl(handler) {
            clientControlHandler = handler;
        },
        sendData(paneId, bytes) {
            if (closed)
                return;
            sessionProxyDataHandler?.(paneId, bytes);
        },
        onData(handler) {
            clientDataHandler = handler;
        },
        onClose(handler) {
            clientCloseHandlers.add(handler);
            return () => { clientCloseHandlers.delete(handler); };
        },
        close(err) {
            if (closed)
                return;
            closed = true;
            // Notify the remote (sessionProxy) side first, then self.
            for (const h of sessionProxyCloseHandlers)
                h(err);
            for (const h of clientCloseHandlers)
                h(err);
        },
    };
    // Cross-wire: session-proxy's incoming handlers come from sessionProxyControlHandler /
    // sessionProxyDataHandler (set via sessionProxy.onControl / sessionProxy.onData).
    // The send* methods on session-proxy deliver to the *client* handlers.
    // This is already handled above by the closures — no extra wiring needed.
    return { sessionProxy, client };
}
//# sourceMappingURL=transport.js.map