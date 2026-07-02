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
import { FRAME_MAGIC, MAX_FRAME, decodeFrame, encodeFrame } from "@tmuxcc/protocol";
// ---------------------------------------------------------------------------
// Control-plane framing constants
// ---------------------------------------------------------------------------
/** Size of the control-plane length prefix. */
const CTRL_LEN_SIZE = 4;
// Per-pane sequence counter map (per transport instance).
// In production the session-proxy owns sequence numbers; the server-proxy socket transport
// increments them per pane.
const MAX_U32 = 0xffffffff;
// ---------------------------------------------------------------------------
// SocketTransport
// ---------------------------------------------------------------------------
class SocketTransport {
    _socket;
    _controlHandler = null;
    _dataHandler = null;
    _closeHandlers = new Set();
    _buf = Buffer.alloc(0);
    _closed = false;
    // Per-pane seq counters for sendData
    _dataSeqs = new Map();
    // tc-7xv.6 / tc-7xv.24 backpressure: when socket.write() returns false (its
    // kernel send-buffer is full) we record a single shared "drain" promise here
    // and resolve it from socket's 'drain' event.  All subsequent sendData /
    // sendControl callers receive the same promise so the upstream pipeline can
    // await it before producing more bytes.  This is the standard Node.js
    // Writable backpressure contract — see https://nodejs.org/api/stream.html
    // "Buffering".  Without this, session-proxy-side flow-control credits bytes as
    // "drained" the instant they enter the kernel send buffer, so tmux is never
    // told to pause and the session-proxy's outbound buffer grows without bound — the
    // root cause of the `find /` wedge.
    _drainPromise = null;
    _drainResolve = null;
    // tc-edf8: backpressure (drain) observability. One "window" spans from the
    // first write()==false (which allocates `_drainPromise`) to the 'drain' event
    // that resolves it. `_drainWaiters` counts the sends enqueued onto the
    // current window (each contributes +1 to the queue-depth gauge); they all
    // share one promise, so the gauge reads concurrent backpressured senders.
    // `_drainWindowOpenedAt` is the window-open timestamp (ms) used to observe
    // per-send time-in-queue at drain. No-op when no metrics hook is wired.
    _metrics;
    _drainWaiters = 0;
    _drainWindowOpenedAt = 0;
    constructor(socket, metrics) {
        this._socket = socket;
        this._metrics = metrics ?? null;
        socket.on("data", (chunk) => { this._onData(chunk); });
        socket.on("close", () => { this._onClose(); });
        socket.on("error", (err) => { this._onClose(err); });
        socket.on("drain", () => {
            // Kernel send-buffer has drained.  Resolve the shared drain promise so
            // all backpressured callers can proceed, then clear the field so the
            // next backpressure window allocates a fresh promise.
            const r = this._drainResolve;
            this._drainPromise = null;
            this._drainResolve = null;
            // tc-edf8: the window closed — observe each waiting send's queue time and
            // drop the gauge back to 0 for this transport.
            this._noteDrainResolved();
            if (r !== null)
                r();
        });
    }
    /**
     * tc-edf8: settle the current backpressure window's metrics.
     *
     * Called when the window closes (a 'drain' event, or close()/_onClose()
     * releasing awaiters). For each send that waited on this window, observe the
     * wall time it spent queued (window-open → now) and decrement the aggregate
     * queue-depth gauge so it returns to 0 for this transport. Idempotent: a
     * no-op when no window is open (`_drainWaiters === 0`).
     */
    _noteDrainResolved() {
        if (this._drainWaiters === 0)
            return;
        const waiters = this._drainWaiters;
        this._drainWaiters = 0;
        if (this._metrics !== null) {
            const waitedSeconds = (Date.now() - this._drainWindowOpenedAt) / 1000;
            this._metrics.addSocketFeedQueueDepth(-waiters);
            for (let i = 0; i < waiters; i++) {
                this._metrics.observeSocketFeedTimeInQueue(waitedSeconds);
            }
        }
    }
    // ── Control plane ──────────────────────────────────────────────────────────
    sendControl(msg) {
        // tc-295a.38: guard on BOTH _closed and socket.destroyed.  _closed is set
        // by our own close() / _onClose() calls; socket.destroyed can become true
        // first when the OS socket is torn down externally (e.g. a remote RST that
        // arrives before our 'close' event handler runs).  Checking socket.destroyed
        // prevents a write-after-destroy call that would produce an unhandled async
        // EPIPE on Node.js internal write-queue flush.
        if (this._closed || this._socket.destroyed)
            return;
        const json = JSON.stringify(msg);
        const payload = Buffer.from(json + "\n", "utf8");
        // Length-prefix the control message (4-byte u32be)
        const lenBuf = Buffer.allocUnsafe(CTRL_LEN_SIZE);
        lenBuf.writeUInt32BE(payload.length, 0);
        // Combine len+payload into a single write call so they cannot interleave
        // with concurrent data-plane frames at the kernel boundary.  This also
        // means socket.write returns one backpressure signal for the pair.
        const ok = this._socket.write(Buffer.concat([lenBuf, payload]));
        if (!ok)
            return this._ensureDrainPromise();
    }
    onControl(handler) {
        this._controlHandler = handler;
    }
    // ── Data plane ─────────────────────────────────────────────────────────────
    sendData(paneId, bytes) {
        // tc-295a.38: see sendControl for the dual guard rationale.
        if (this._closed || this._socket.destroyed)
            return;
        // Mint a per-pane seq and encode as a data frame
        const key = String(paneId);
        const seq = (this._dataSeqs.get(key) ?? 0);
        this._dataSeqs.set(key, (seq + 1) & MAX_U32);
        const frame = encodeFrame(paneId, seq, bytes);
        const ok = this._socket.write(frame);
        if (!ok)
            return this._ensureDrainPromise();
    }
    /**
     * Lazily build a shared promise that resolves on the next 'drain' event.
     *
     * One shared promise per backpressure window.  Concurrent senders that hit
     * write()==false during the same window all await the same promise, so the
     * pipeline can use `await tx.sendData(...)` as a natural backpressure point
     * without registering N drain listeners.
     *
     * The constructor's 'drain' handler nullifies the field and invokes the
     * stored resolve so the next backpressure window starts fresh.
     */
    _ensureDrainPromise() {
        // tc-edf8: every caller that reaches here is a send that hit write()==false
        // and is now enqueued onto the drain wait — count it. The first waiter
        // opens the window (records the open timestamp); concurrent waiters join
        // the same shared promise, so the queue-depth gauge reads concurrent
        // backpressured senders. The matching decrements + time-in-queue
        // observations fire in _noteDrainResolved() when the window closes.
        if (this._closed || this._socket.destroyed)
            return Promise.resolve();
        if (this._drainWaiters === 0) {
            this._drainWindowOpenedAt = Date.now();
        }
        this._drainWaiters++;
        this._metrics?.addSocketFeedQueueDepth(1);
        if (this._drainPromise !== null)
            return this._drainPromise;
        this._drainPromise = new Promise((resolve) => {
            this._drainResolve = resolve;
        });
        return this._drainPromise;
    }
    onData(handler) {
        this._dataHandler = handler;
    }
    // ── Lifecycle ──────────────────────────────────────────────────────────────
    onClose(handler) {
        this._closeHandlers.add(handler);
        return () => { this._closeHandlers.delete(handler); };
    }
    close(err) {
        if (this._closed)
            return;
        this._closed = true;
        // Release any awaiters on the drain promise so they can observe the close
        // through their next send (which returns immediately when this._closed).
        const r = this._drainResolve;
        this._drainPromise = null;
        this._drainResolve = null;
        // tc-edf8: the window is being torn down — settle its metrics so the
        // aggregate queue-depth gauge does not leak a standing depth on disconnect.
        this._noteDrainResolved();
        if (r !== null)
            r();
        this._socket.destroy(err);
        for (const h of this._closeHandlers)
            h(err);
        this._closeHandlers.clear();
    }
    // ── Incoming data parser ───────────────────────────────────────────────────
    _onData(chunk) {
        // tc-7xv.6 / tc-7xv.24: Buffer.concat([this._buf, chunk]) is O(n²) when
        // chunks arrive rapidly and the buffer is large — a contributing factor to
        // the firehose wedge.  Concatenating with an explicit totalLength avoids
        // the intermediate length computation traversal and lets V8 short-cut the
        // copy when the result is sized correctly.
        this._buf = Buffer.concat([this._buf, chunk], this._buf.length + chunk.length);
        this._processBuffer();
    }
    /**
     * Drain `_buf` one message at a time.
     *
     * After dispatching each control-plane message, check whether `_controlHandler`
     * changed as a side-effect of the dispatch (e.g. `runServerHandshake`'s
     * `settle()` replaces the handler with a no-op after receiving
     * `client.capabilities`).  When the handler has changed, stop processing and
     * reschedule via `process.nextTick`.
     *
     * Why: when `client.capabilities` and `command.request` arrive in the same
     * socket data chunk (OS batching under load), the naive while-loop would
     * dispatch `command.request` using the no-op handler installed by `settle()`,
     * silently dropping the command before `_handleConnection` can install its
     * real command handler.  The `process.nextTick` reschedule gives the
     * microtask queue — including `_handleConnection`'s async continuation that
     * calls `transport.onControl(commandHandler)` — a chance to run before the
     * next buffered message is dispatched.
     */
    _processBuffer() {
        while (this._buf.length > 0) {
            // A dispatched handler may close the transport synchronously — stop
            // delivering buffered messages the moment that happens.
            if (this._closed)
                return;
            const firstByte = this._buf[0];
            if (firstByte === FRAME_MAGIC) {
                // Data-plane frame: parse the header HERE and consume EXACTLY one
                // frame's bytes from `_buf`, leaving any trailing bytes (more data
                // frames OR control messages) for the next loop iteration.
                //
                // tc-3y8.9 root cause: the previous implementation fed the ENTIRE
                // remaining buffer to a stateful FrameDecoder and cleared `_buf`.
                // Exact byte boundaries were lost, with two fatal consequences on a
                // real socket (reads do not respect write boundaries):
                //
                //   (A) A control message coalesced into the same chunk AFTER a data
                //       frame hit FrameDecoder's magic check (its length prefix starts
                //       0x00 ≠ 0xCC) → RangeError → transport torn down — the control
                //       message (e.g. a pane.opened delta) died with the connection.
                //   (B) A data frame SPLIT across two 'data' events left the decoder
                //       holding the prefix while the continuation chunk — whose first
                //       byte is arbitrary terminal-output payload, not 0xCC — was
                //       misrouted to the control branch.  Its leading bytes were
                //       misread as a u32be JSON length (printable ASCII ⇒ hundreds of
                //       MB), so `_buf` waited forever for bytes that never come:
                //       inbound silently stalled while the socket stayed open.
                //       Outbound sends kept working — commands still reached tmux
                //       while every session-proxy→client live delta vanished (the dead
                //       live-delta path of tc-3y8.9 / the load-dependent delta stalls
                //       of tc-3y8.4).
                //
                // Frame layout (framing.ts):
                //   [0xCC][u32be SEQ][u32be PAYLEN @5][u16be IDLEN @9][PANEID][PAYLOAD]
                const FRAME_HEADER_SIZE = 11;
                if (this._buf.length < FRAME_HEADER_SIZE)
                    break; // wait for full header
                const payLen = this._buf.readUInt32BE(5);
                const idLen = this._buf.readUInt16BE(9);
                // Enforce the MAX_FRAME cap BEFORE waiting for the body, otherwise a
                // corrupt/hostile PAYLEN (up to ~4 GiB) would stall the demux forever
                // waiting for bytes that never arrive — the same silent-death mode
                // this rewrite eliminates.
                if (payLen > MAX_FRAME) {
                    this.close(new Error("data-plane framing error"));
                    return;
                }
                const totalFrameLen = FRAME_HEADER_SIZE + idLen + payLen;
                if (this._buf.length < totalFrameLen)
                    break; // wait for complete frame
                const frameBytes = this._buf.subarray(0, totalFrameLen);
                this._buf = this._buf.subarray(totalFrameLen);
                let frame;
                try {
                    frame = decodeFrame(frameBytes);
                }
                catch {
                    // Genuinely malformed frame (cannot happen for length/magic — both
                    // validated above — but decodeFrame is the single source of truth).
                    this.close(new Error("data-plane framing error"));
                    return;
                }
                this._dataHandler?.(frame.paneId, frame.payload);
            }
            else {
                // Control-plane: expect [u32be len][JSON bytes + "\n"]
                if (this._buf.length < CTRL_LEN_SIZE)
                    break; // wait for more data
                const payloadLen = this._buf.readUInt32BE(0);
                const totalLen = CTRL_LEN_SIZE + payloadLen;
                if (this._buf.length < totalLen)
                    break; // wait for complete message
                const payload = this._buf.subarray(CTRL_LEN_SIZE, totalLen);
                this._buf = this._buf.subarray(totalLen);
                const prevHandler = this._controlHandler;
                try {
                    const jsonStr = payload.toString("utf8").trim();
                    const msg = JSON.parse(jsonStr);
                    this._controlHandler?.(msg);
                }
                catch {
                    // Malformed JSON — discard
                }
                // If the handler changed as a side-effect of dispatch (e.g. settle()
                // installed a no-op), stop processing here and reschedule the remainder
                // so that microtasks (including async continuations that install the real
                // command handler) can run before the next buffered message is dispatched.
                //
                // IMPORTANT: use setImmediate, NOT process.nextTick.
                //
                // In Node.js, process.nextTick callbacks run BEFORE Promise microtasks
                // in the same event loop turn.  The post-handshake onControl installation
                // in _handleConnection happens inside an async/await continuation:
                //
                //   settle(() => resolve(session))  ← queues Promise microtask
                //   process.nextTick(...)           ← fires BEFORE that microtask!
                //   → _processBuffer runs with no-op handler still installed
                //   → command.request dispatched to no-op → DROPPED
                //   → _handleConnection finally runs, installs real handler — too late
                //
                // setImmediate fires AFTER all microtasks (Promises) have drained,
                // giving the _handleConnection async continuation time to install the
                // real command handler before the next buffered message is dispatched.
                if (this._controlHandler !== prevHandler && this._buf.length > 0) {
                    setImmediate(() => { this._processBuffer(); });
                    return;
                }
            }
        }
    }
    _onClose(err) {
        if (this._closed)
            return;
        this._closed = true;
        // Release any awaiters on the drain promise so they can observe the close.
        const r = this._drainResolve;
        this._drainPromise = null;
        this._drainResolve = null;
        // tc-edf8: settle the open window's metrics so the gauge returns to 0.
        this._noteDrainResolved();
        if (r !== null)
            r();
        for (const h of this._closeHandlers)
            h(err);
        this._closeHandlers.clear();
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Wrap an existing net.Socket as a two-plane Transport.
 *
 * @param metrics - Optional backpressure metrics hook (tc-edf8). When supplied,
 *   the transport reports its drain-path queue depth and per-send time-in-queue.
 */
export function createSocketTransport(socket, metrics) {
    return new SocketTransport(socket, metrics);
}
/**
 * Dial a unix socket and return a Transport.
 * Resolves once the connection is established.
 *
 * @param metrics - Optional backpressure metrics hook (tc-edf8).
 */
export function connectSocketTransport(socketPath, metrics) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once("connect", () => {
            socket.off("error", reject);
            resolve(new SocketTransport(socket, metrics));
        });
        socket.once("error", reject);
    });
}
/**
 * Start a unix socket server. Each accepted connection is wrapped as a
 * Transport and passed to `onConnection`.
 *
 * Returns a handle with a `close()` method.
 */
export function createSocketServer(socketPath, onConnection, opts = {}) {
    return new Promise((resolve, reject) => {
        let connectionCount = 0;
        const server = net.createServer((socket) => {
            connectionCount++;
            opts.onConnectionCountChange?.(connectionCount);
            socket.once("close", () => {
                connectionCount--;
                opts.onConnectionCountChange?.(connectionCount);
            });
            onConnection(new SocketTransport(socket, opts.metrics));
        });
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve({
                close() {
                    return new Promise((res, rej) => {
                        server.close((err) => (err ? rej(err) : res()));
                    });
                },
            });
        });
    });
}
//# sourceMappingURL=socket-transport.js.map