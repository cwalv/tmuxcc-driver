/**
 * Unix socket transport — a Transport implementation over a Node.js net.Socket.
 *
 * # Multiplexing protocol
 *
 * Both control-plane and data-plane traffic share a single unix socket
 * connection. The leading byte of each framing unit routes the traffic:
 *
 *   byte 0 == 0xCC → data-plane frame (framing.ts DataFrame binary format)
 *   byte 0 != 0xCC → control-plane (newline-delimited JSON)
 *
 * This matches the contract in SCHEMA.md §"Data plane":
 *   "Control-plane and data-plane traffic are multiplexed on the same
 *    connection via a leading magic byte (data plane: 0xCC; control plane:
 *    JSON, never starts with 0xCC)."
 *
 * # Data-plane framing (framing.ts format)
 *
 * Data frames on the wire use the format defined in framing.ts / SCHEMA.md:
 *   [u8 MAGIC=0xCC][u32be SEQ][u32be PAYLEN][u16be IDLEN][PANEID UTF-8][PAYLOAD]
 *
 * Total frame size: 11 + IDLEN + PAYLEN bytes. The receive path parses the
 * frame header inline so it can consume EXACTLY one frame's bytes at a time —
 * exact boundary tracking is what lets data and control units interleave
 * arbitrarily across socket read chunks (tc-3y8.9; see _processBuffer).
 *
 * On the SEND side, `encodeFrame(paneId, seq, payload)` from @tmuxcc/protocol
 * produces the binary blob; we write it directly to the socket.
 *
 * # Control-plane framing (length-prefixed JSON)
 *
 * To avoid partial-JSON reads and to support multi-line values, each control
 * message is framed with a 4-byte u32be length prefix:
 *   [u32be len][JSON UTF-8 bytes]
 *
 * Since JSON never starts with 0xCC (that would require a UTF-8 character at
 * code point 0xCC, which is a multi-byte sequence and thus NEVER the first
 * byte of a JSON object/array/string/primitive), the leading byte of each unit
 * is sufficient to route:
 *   - 0xCC → data frame
 *   - 0x00..0xCB, 0xCD..0xFF → control-plane length prefix first byte
 *
 * A 4-byte length prefix with value ≤ 2^24-1 has first byte 0x00, which is
 * never 0xCC. Messages up to 2^32 bytes are supported (enough for any
 * control-plane message in practice).
 *
 * @module socket-transport
 */
import * as net from "node:net";
import type { Transport } from "@tmuxcc/protocol";
/**
 * The slice of `ServerProxyMetrics` the socket transport needs to report its
 * backpressure (drain) path. Kept as a narrow structural type so the transport
 * does not import the server-proxy metrics module (boundary discipline) — the
 * broker passes a handle that already satisfies it.
 *
 * - `addSocketFeedQueueDepth(delta)`: `+1` when a send is enqueued onto the
 *   drain wait (write()==false), `-n` when a drain resolves n waiting sends.
 * - `observeSocketFeedTimeInQueue(seconds)`: per-send wait time, observed once
 *   per enqueued send at the drain that releases it.
 */
export interface SocketTransportMetrics {
    addSocketFeedQueueDepth(delta: number): void;
    observeSocketFeedTimeInQueue(seconds: number): void;
}
/**
 * Wrap an existing net.Socket as a two-plane Transport.
 *
 * @param metrics - Optional backpressure metrics hook (tc-edf8). When supplied,
 *   the transport reports its drain-path queue depth and per-send time-in-queue.
 */
export declare function createSocketTransport(socket: net.Socket, metrics?: SocketTransportMetrics): Transport;
/**
 * Dial a unix socket and return a Transport.
 * Resolves once the connection is established.
 *
 * @param metrics - Optional backpressure metrics hook (tc-edf8).
 */
export declare function connectSocketTransport(socketPath: string, metrics?: SocketTransportMetrics): Promise<Transport>;
/** Options for createSocketServer. */
export interface SocketServerOptions {
    /**
     * Invoked with the new connection count whenever a connection is accepted
     * or an accepted connection fully closes (tc-3iv idle-exit tracking).
     *
     * Counting happens at the raw `net.Socket` level — NOT via
     * `Transport.onClose` — because the wire handshake registers and then
     * unsubscribes its own close handler, and any consumer registered before
     * the handshake completes would see the close whether or not the handshake
     * succeeded; a socket `close` event fires exactly once per accepted
     * connection, no matter how the connection ends.
     */
    onConnectionCountChange?: (count: number) => void;
    /**
     * Optional backpressure metrics hook (tc-edf8). When supplied, every accepted
     * connection's transport reports its drain-path queue depth and per-send
     * time-in-queue, AGGREGATE across all connections on the registry behind the
     * hook (the broker's `ServerProxyMetrics`).
     */
    metrics?: SocketTransportMetrics;
}
/**
 * Start a unix socket server. Each accepted connection is wrapped as a
 * Transport and passed to `onConnection`.
 *
 * Returns a handle with a `close()` method.
 */
export declare function createSocketServer(socketPath: string, onConnection: (transport: Transport) => void, opts?: SocketServerOptions): Promise<{
    close(): Promise<void>;
}>;
//# sourceMappingURL=socket-transport.d.ts.map