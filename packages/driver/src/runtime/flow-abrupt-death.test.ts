/**
 * tc-76m8.27 — FC-1 accounting on abrupt client death (real tmux).
 *
 * # The bug this file pins
 *
 * A backpressured client's drain credits are DEFERRED: the draining wrapper in
 * session-proxy.ts chains `fc.noteDrained` off the Promise that
 * SocketTransport.sendData returns when `socket.write()` hits backpressure.
 * On abrupt client death (SIGSTOP a client so it stops reading, flood it,
 * SIGKILL it — the tc-76m8.23 repro), SocketTransport._onClose:
 *
 *   1. resolves the shared drain promise (to release awaiters), which QUEUES
 *      every deferred credit as a microtask, then
 *   2. fires the close handlers SYNCHRONOUSLY — including session-proxy's
 *      handler, which calls `fc.removeClient(transport)` and discards the
 *      dead client's sub-ledgers (the correct reconciliation: nothing is owed
 *      to a dead client).
 *
 * The microtasks from (1) then run AFTER (2), so every deferred credit landed
 * on an already-discarded ledger — one "DRAIN CLAMPED" FC-1 tripwire hit per
 * queued chunk. The ordering is deterministic (microtasks run after the
 * synchronous close handlers), not a race.
 *
 * The fix suppresses drain credits once the client transport has closed:
 * bytes that died in the send queue were never drained by anyone, and
 * removeClient IS the reconciliation. These tests assert the expected-zero
 * `flow_drain_clamped_total` counter stays 0 across an abrupt death.
 *
 * # Coverage
 *
 *   T1. Full production path: real unix socket + real SocketTransport +
 *       real kernel backpressure. The client socket stops reading (SIGSTOP
 *       analogue), a real pane floods it past the kernel's socket buffers,
 *       then the socket is destroyed abruptly (SIGKILL analogue). The clamp
 *       tripwire must not fire, and the session-proxy must remain healthy
 *       (dead client fully removed; a fresh client can attach).
 *
 *   T2. Ordering-exact repro with a scripted transport that mimics
 *       SocketTransport._onClose (resolve drain promise, then fire close
 *       handlers synchronously) — deterministic, independent of kernel
 *       buffer sizes. Also asserts the dead client's ledger is fully
 *       reconciled (bufferedBytes back to 0).
 *
 * @module runtime/flow-abrupt-death.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import {
  createInMemoryTransportPair,
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
} from "@tmuxcc/protocol";
import type { Transport, CloseHandler, PaneId } from "@tmuxcc/protocol";

import { createSessionProxy } from "./session-proxy.js";
import type { SessionProxy } from "./session-proxy.js";
import { createSocketTransport } from "../socket-transport.js";
import { trackSocket, killTmuxServer } from "./test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// tmux guard + socket bookkeeping (mirrors size-ownership.e2e.test.ts).
// ---------------------------------------------------------------------------

const tmuxAvailable = (() => {
  try {
    const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
    return r.status === 0 && /tmux\s+\d/.test(r.stdout ?? "");
  } catch {
    return false;
  }
})();

const RUN_SUFFIX = `${Date.now()}`;

function sockName(label: string): string {
  // tc-bpn shape: tmuxcc-test-<pid>-...; trackSocket BEFORE spawn so a thrown
  // test still gets its server reaped by the process-exit net.
  const sock = `tmuxcc-test-${process.pid}-fad-${RUN_SUFFIX}-${label}`;
  trackSocket(sock);
  return sock;
}

const CLIENT_CAPS = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: [
    "pane-lifecycle" as const,
    "layout-updates" as const,
    "focus-events" as const,
    "input-forwarding" as const,
  ],
};

function firstPaneId(sessionProxy: SessionProxy): PaneId {
  const it = sessionProxy.pipeline.getModel().panes.keys().next();
  assert.ok(!it.done, "session must have at least one pane after start");
  return it.value as PaneId;
}

/** Parse the expected-zero clamp counter out of the prom exposition text. */
async function drainClampedTotal(sessionProxy: SessionProxy): Promise<number> {
  const text = await sessionProxy.metrics.metrics();
  const m = text.match(/^flow_drain_clamped_total (\d+)$/m);
  assert.ok(m !== null, `flow_drain_clamped_total missing from exposition:\n${text.slice(0, 500)}`);
  return Number(m[1]);
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  what: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`Timeout (${timeoutMs}ms): ${what()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe(
  "tc-76m8.27: FC-1 accounting survives abrupt client death (real tmux)",
  { skip: !tmuxAvailable ? "tmux not found on PATH" : false },
  () => {
    // -----------------------------------------------------------------------
    // T1 — full production path over a real unix socket.
    //
    // SIGSTOP analogue: clientSocket.pause() (the peer stops reading, so the
    // kernel socket buffers fill and the server-side write() backpressures).
    // SIGKILL analogue: clientSocket.destroy() (the fd is torn down with the
    // queue full — the server side sees close/ECONNRESET, exactly what a
    // killed process produces).
    //
    // highWaterBytes is raised to 8 MiB so flow control does NOT pause the
    // pane before real backpressure produces deferred drain credits: the
    // kernel absorbs ~a few hundred KiB (rmem+wmem), so a 2 MB flood
    // guarantees write()==false — witnessed via the transport's backpressure
    // metrics hook as the test's precondition.
    // -----------------------------------------------------------------------
    it(
      "T1: SIGSTOP+flood+SIGKILL analogue over a real socket does not trip the clamp; session-proxy stays healthy",
      { timeout: 60_000 },
      async () => {
        const sock = sockName("t1");
        after(() => killTmuxServer(sock));
        const sessionProxy = createSessionProxy({
          host: { socketName: sock, sessionName: "fad-t1", cols: 80, rows: 24 },
          flow: { highWaterBytes: 8 * 1024 * 1024, lowWaterBytes: 65_536 },
        });
        sessionProxy.host.onError(() => {});
        await sessionProxy.start();

        const sockPath = path.join(os.tmpdir(), `tmuxcc-test-${process.pid}-fad-${RUN_SUFFIX}.sock`);
        let server: net.Server | undefined;
        const clientSock: net.Socket[] = [];
        try {
          // Test-owned unix socket server: every accepted connection becomes a
          // real SocketTransport fed to the REAL sessionProxy.addClient wiring
          // (drainingTransport + onClose teardown — the path under test).
          let backpressuredSends = 0;
          const addClientDone: Array<Promise<unknown>> = [];
          server = net.createServer((s) => {
            const st = createSocketTransport(s, {
              addSocketFeedQueueDepth(delta: number) {
                if (delta > 0) backpressuredSends += delta;
              },
              observeSocketFeedTimeInQueue() {},
            });
            addClientDone.push(sessionProxy.addClient(st));
          });
          await new Promise<void>((res, rej) => {
            server!.once("error", rej);
            server!.listen(sockPath, () => res());
          });

          // Client connects and handshakes over the real socket.
          const cs = net.createConnection(sockPath);
          clientSock.push(cs);
          await new Promise<void>((res, rej) => {
            cs.once("connect", () => res());
            cs.once("error", rej);
          });
          cs.on("error", () => {}); // post-destroy noise
          const clientTransport = createSocketTransport(cs);
          await runClientHandshake(clientTransport, CLIENT_CAPS);
          assert.equal(addClientDone.length, 1, "server must have accepted exactly one client");
          await addClientDone[0];

          const pid = firstPaneId(sessionProxy);
          let seq = 1;

          // SIGSTOP analogue: the client stops reading its socket.
          cs.pause();

          // Flood: 2 MB of pane output through the real %output → accounting
          // store → demux fan-out → SocketTransport path.
          clientTransport.sendControl({
            type: "input",
            seq: ++seq,
            paneId: pid,
            data: "head -c 2000000 /dev/zero | tr '\\0' x; echo FLOOD-DONE\n",
          });

          // Precondition: real backpressure engaged (write()==false), i.e.
          // deferred drain credits exist. Without this the test is vacuous.
          await waitFor(
            () => (backpressuredSends > 0 ? true : undefined),
            30_000,
            () =>
              `server-side transport never backpressured; ` +
              `bufferedBytes=${sessionProxy.flowController.bufferedBytes(pid)} ` +
              `(kernel socket buffers may exceed the 2 MB flood)`,
          );

          // SIGKILL analogue: tear the client down with the queue full.
          cs.destroy();

          // The server side observes the close and removes the client.
          await waitFor(
            () => (sessionProxy.server.clientCount() === 0 ? true : undefined),
            10_000,
            () => `dead client never removed; clientCount=${sessionProxy.server.clientCount()}`,
          );

          // Let the released drain-promise microtasks (the deferred credits)
          // and any close-path macrotasks settle.
          await new Promise((r) => setTimeout(r, 250));

          // THE invariant: the expected-zero FC-1 tripwire did not fire.
          const clamped = await drainClampedTotal(sessionProxy);
          assert.equal(
            clamped,
            0,
            `flow_drain_clamped_total must stay 0 across an abrupt client death; got ${clamped} ` +
              `(deferred drain credits landed after removeClient discarded the ledger)`,
          );

          // Health: a fresh client can attach and handshake cleanly.
          const { sessionProxy: dt2, client: ct2 } = createInMemoryTransportPair();
          const p2 = sessionProxy.addClient(dt2);
          await runClientHandshake(ct2, CLIENT_CAPS);
          await p2;
          assert.equal(sessionProxy.server.clientCount(), 1, "fresh client must attach after the death");
          dt2.close();
        } finally {
          for (const s of clientSock) s.destroy();
          if (server !== undefined) await new Promise<void>((r) => server!.close(() => r()));
          fs.rmSync(sockPath, { force: true });
          sessionProxy.kill();
          killTmuxServer(sock);
        }
      },
    );

    // -----------------------------------------------------------------------
    // T2 — ordering-exact repro, independent of kernel buffer sizes.
    //
    // A scripted client transport returns a shared pending Promise from
    // sendData once "backpressure" is enabled (SocketTransport's shared
    // drain-promise contract), and its die() mimics SocketTransport._onClose
    // EXACTLY (socket-transport.ts): resolve the drain promise — queueing the
    // deferred credits as microtasks — THEN fire the close handlers
    // synchronously. Pre-fix, every deferred chunk tripped the clamp.
    // -----------------------------------------------------------------------
    it(
      "T2: deferred drain credits released by the close path do not debit the discarded ledger",
      { timeout: 60_000 },
      async () => {
        const sock = sockName("t2");
        after(() => killTmuxServer(sock));
        const sessionProxy = createSessionProxy({
          host: { socketName: sock, sessionName: "fad-t2", cols: 80, rows: 24 },
        });
        sessionProxy.host.onError(() => {});
        await sessionProxy.start();

        try {
          // Scripted client transport with SocketTransport's backpressure and
          // close-ordering semantics.
          const { sessionProxy: raw, client: clientTransport } = createInMemoryTransportPair();
          let drainResolve: (() => void) | null = null;
          let drainPromise: Promise<void> | null = null;
          let backpressured = false;
          let dataSends = 0;
          const closeHandlers = new Set<CloseHandler>();
          const transport: Transport = {
            sendControl: (m) => raw.sendControl(m),
            onControl: (h) => raw.onControl(h),
            onData: (h) => raw.onData(h),
            sendData(pid: PaneId, bytes: Uint8Array): void | Promise<void> {
              void raw.sendData(pid, bytes);
              if (!backpressured || bytes.length === 0) return undefined;
              dataSends++;
              if (drainPromise === null) {
                drainPromise = new Promise<void>((res) => {
                  drainResolve = res;
                });
              }
              return drainPromise;
            },
            onClose(h: CloseHandler) {
              closeHandlers.add(h);
              return () => closeHandlers.delete(h);
            },
            close(err?: Error) {
              raw.close(err);
            },
          };
          /** Abrupt death with SocketTransport._onClose's exact ordering. */
          function die(): void {
            const r = drainResolve;
            drainPromise = null;
            drainResolve = null;
            if (r !== null) r(); // deferred credits become queued microtasks…
            for (const h of closeHandlers) h(); // …close handlers run first, synchronously
            closeHandlers.clear();
          }

          // Attach through the REAL sessionProxy.addClient wiring and wait for
          // hydration to finish so subsequent fan-out is not queue-gated.
          const clientMsgs: Array<{ type: string }> = [];
          const addP = sessionProxy.addClient(transport);
          await runClientHandshake(clientTransport, CLIENT_CAPS);
          clientTransport.onControl((m) => clientMsgs.push(m as { type: string }));
          await addP;
          await waitFor(
            () => (clientMsgs.some((m) => m.type === "pane.hydration.end") ? true : undefined),
            10_000,
            () => `hydration never completed; saw: ${clientMsgs.map((m) => m.type).join(",")}`,
          );

          const pid = firstPaneId(sessionProxy);
          const fc = sessionProxy.flowController;

          // Flood 25 × 4 KiB with the client backpressured — the exact
          // accounting-store append order (fc.onPaneBytes BEFORE the fan-out;
          // session-proxy.ts accountingStore). 100 KiB stays below the default
          // high-water mark, so this exercises pure backpressure (no pause).
          backpressured = true;
          const chunk = new Uint8Array(4096).fill(0x78);
          for (let i = 0; i < 25; i++) {
            fc.onPaneBytes(pid, chunk.length);
            sessionProxy.demux.store.append(pid, chunk);
          }
          assert.equal(dataSends, 25, "precondition: all 25 chunks must reach the client transport");
          assert.equal(fc.bufferedBytes(pid), 25 * 4096, "precondition: ledger holds the undrained flood");

          // Abrupt death.
          die();
          await new Promise((r) => setImmediate(r)); // run the released microtasks

          const clamped = await drainClampedTotal(sessionProxy);
          assert.equal(
            clamped,
            0,
            `flow_drain_clamped_total must stay 0 when close releases the deferred credits; got ${clamped}`,
          );
          assert.equal(
            sessionProxy.server.clientCount(),
            0,
            "dead client must be removed by the close handlers",
          );
          assert.equal(
            fc.bufferedBytes(pid),
            0,
            "removeClient must fully reconcile the dead client's ledger",
          );
        } finally {
          sessionProxy.kill();
          killTmuxServer(sock);
        }
      },
    );
  },
);
