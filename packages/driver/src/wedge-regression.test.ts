/**
 * wedge-regression.test.ts — tc-7xv.24 regression: real-socket backpressure.
 *
 * # What this verifies
 *
 * The wedge bug (tc-7xv.24): under sustained high-throughput pane output
 * (e.g. `find /` in a tmuxcc terminal) the pty wedged because the server-proxy's
 * `SocketTransport.sendData` ignored Node's backpressure return value.  When
 * the consumer was slow:
 *
 *   1. tmux fired %output bytes into the session-proxy pipeline.
 *   2. demux.store.append called transport.sendData.
 *   3. socket.write returned false (kernel send buffer full).
 *   4. SocketTransport ignored the return value (fire-and-forget).
 *   5. sessionProxy.addClient wrapper called fc.noteDrained immediately, crediting
 *      the bytes as drained the instant they entered the kernel send buffer.
 *   6. fc.bufferedBytes never grew → high-water never crossed → tmux never
 *      paused → session-proxy's outbound buffer grew without bound until V8 stalled.
 *
 * The fix (tc-7xv.6):
 *
 *   - SocketTransport.sendData returns Promise<void> when socket.write returns
 *     false.  The promise resolves on the socket's 'drain' event.
 *   - sessionProxy.addClient's wrapper chains fc.noteDrained off that promise so the
 *     drain credit fires only after actual consumer consumption.
 *   - Now fc.bufferedBytes accurately reflects in-flight bytes; under a slow
 *     consumer it crosses high-water and tmux is correctly told to pause.
 *
 * # How this test works (no real tmux required)
 *
 * We build a fake TmuxHost that records writes (so we can observe pause /
 * continue commands) plus a real SocketTransport pair (Unix domain sockets).
 * The consumer side pauses its socket (`sock.pause()`), simulating a stalled
 * VS Code extension.  We then call demux.store.append directly with byte
 * batches and assert:
 *
 *   1. fc.bufferedBytes grows past high-water (because drain is gated by the
 *      blocked socket).
 *   2. The fake host receives a pause command (refresh-client -A '%pane:pause').
 *   3. After we resume the consumer side, the socket drains; fc.noteDrained
 *      fires and tmux is told to continue.
 *
 * @module runtime/wedge-regression.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// Pull the flow-control and demux primitives from @tmuxcc/driver (same package —
// all formerly-session-proxy and formerly-server-proxy code is now co-located).
// The SocketTransport also lives in this package, imported via relative path.
import { createOutputDemux } from "./runtime/output-demux.js";
import { createFlowController, DEFAULT_HIGH_WATER_BYTES } from "./runtime/flow-control.js";
import { paneId as mintPaneId } from "@tmuxcc/protocol";
import type { CommandResult } from "./parser/correlator.js";
import type { PaneId, Transport } from "@tmuxcc/protocol";

import { connectSocketTransport } from "./socket-transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpSocketPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tmuxcc-wedge-${label}-`));
  return path.join(dir, "wedge.sock");
}

/**
 * Build a fake `send` callback that records every issued command (tc-3si.1).
 *
 * Under tc-3si.1 the FlowController takes a slot+write `send` callback rather
 * than a host. Each captured entry includes the trailing "\n" so it matches
 * the previous host.write contract (the test's assertions look for ":pause"
 * substrings, which work either way).
 */
function makeFakeSend(): {
  writes: string[];
  send: (command: string) => Promise<CommandResult>;
} {
  const writes: string[] = [];
  const send = (command: string) => {
    writes.push(command + "\n");
    return new Promise<CommandResult>(() => {});
  };
  return { writes, send };
}

/**
 * Build a "draining transport" identical in shape to the one session-proxy.ts wraps
 * around every attached transport — calls fc.noteDrained after sendData (sync
 * or after promise resolution per the tc-7xv.6 fix). Credits are keyed by the
 * RAW `inner` transport, matching production (tc-0wtb); the caller must have
 * registered it via `fc.addClient(inner)`.
 */
function buildDrainingTransport(
  inner: Transport,
  fc: ReturnType<typeof createFlowController>,
): Transport {
  return {
    ...inner,
    sendData(pid: PaneId, bytes: Uint8Array): void | Promise<void> {
      const result = inner.sendData(pid, bytes);
      if (bytes.length === 0) return result;
      if (result !== undefined && typeof (result as Promise<void>).then === "function") {
        return (result as Promise<void>).then(() => {
          fc.noteDrained(pid, bytes.length, inner);
        });
      }
      fc.noteDrained(pid, bytes.length, inner);
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Suite: tc-7xv.24 regression
// ---------------------------------------------------------------------------

describe("tc-7xv.24 wedge regression — real-socket backpressure engages tmux pause", () => {
  it("slow consumer triggers fc pause within bounded time", async () => {
    const sockPath = tmpSocketPath("pause");
    const heldSockets: net.Socket[] = [];

    // Server side: pause reads on accept.  This stalls the client kernel send
    // buffer and forces SocketTransport.sendData to return a Promise.
    const server = net.createServer((sock) => {
      sock.pause();
      heldSockets.push(sock);
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    after(async () => {
      for (const s of heldSockets) { try { s.destroy(); } catch { /* ignore */ } }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    });

    const clientTransport = await connectSocketTransport(sockPath);
    after(() => clientTransport.close());

    // SessionProxy-side wiring (mirrors session-proxy.ts createSessionProxy).
    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux);
    // Register the client so per-client accounting matches production (tc-0wtb).
    fc.addClient(clientTransport);

    // Wrap demux.store with the same accounting tap that production uses.
    const baseStore = demux.store;
    const accountingStore = {
      append(pid: PaneId, bytes: Uint8Array): void {
        baseStore.append(pid, bytes);
        if (bytes.length > 0) fc.onPaneBytes(pid, bytes.length);
      },
      getContents: baseStore.getContents.bind(baseStore),
      size: baseStore.size.bind(baseStore),
      drop: baseStore.drop.bind(baseStore),
      clear: baseStore.clear.bind(baseStore),
    };

    // Attach the draining transport (same wrapper session-proxy.ts addClient builds).
    const drainingTransport = buildDrainingTransport(clientTransport, fc);
    demux.attachTransport(drainingTransport);

    // Pump bytes through accountingStore for a single pane.  Each append
    // simulates one %output notification from tmux.  Chunks are 64 KiB.
    const paneId = mintPaneId("p1");
    // tc-128.4: pane tracking is always-on; bind explicitly so bytes fan
    // out to the draining transport instead of overflowing the pre-topology
    // staging buffer (which would mean the drain credit path never fires).
    demux.notifyPaneBound(paneId);
    const chunk = new Uint8Array(64 * 1024); // 64 KiB of zeros

    // Production high-water is 256 KiB; we should observe pause within
    // a small number of chunks (typically 4–8 chunks, depending on the OS
    // send-buffer size).  Bound the loop generously.
    let pauseSeen = false;
    for (let i = 0; i < 200; i++) {
      accountingStore.append(paneId, chunk);
      // Yield to the event loop so socket writes propagate and 'drain' has a
      // chance to fire if the consumer is alive (it isn't — paused).
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (fc.isPanePaused(paneId)) {
        pauseSeen = true;
        break;
      }
    }

    assert.equal(
      pauseSeen,
      true,
      `flow controller must pause within 200 chunks of slow consumer; ` +
      `bufferedBytes=${fc.bufferedBytes(paneId)} highWater=${DEFAULT_HIGH_WATER_BYTES}`,
    );

    // The host must have received a refresh-client -A '%1:pause' command.
    const pauseCmd = writes.find((w) => w.includes(":pause"));
    assert.ok(
      pauseCmd !== undefined,
      `fake host must have received a pause command (got ${writes.length} writes)`,
    );
  });

  it("resuming consumer drains buffered bytes and unpauses tmux", async () => {
    const sockPath = tmpSocketPath("resume");
    const heldSockets: net.Socket[] = [];

    const server = net.createServer((sock) => {
      sock.pause();
      heldSockets.push(sock);
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    after(async () => {
      for (const s of heldSockets) { try { s.destroy(); } catch { /* ignore */ } }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    });

    const clientTransport = await connectSocketTransport(sockPath);
    after(() => clientTransport.close());

    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux);
    // Register the client so per-client accounting matches production (tc-0wtb).
    fc.addClient(clientTransport);

    const baseStore = demux.store;
    const accountingStore = {
      append(pid: PaneId, bytes: Uint8Array): void {
        baseStore.append(pid, bytes);
        if (bytes.length > 0) fc.onPaneBytes(pid, bytes.length);
      },
      getContents: baseStore.getContents.bind(baseStore),
      size: baseStore.size.bind(baseStore),
      drop: baseStore.drop.bind(baseStore),
      clear: baseStore.clear.bind(baseStore),
    };

    const drainingTransport = buildDrainingTransport(clientTransport, fc);
    demux.attachTransport(drainingTransport);

    const paneId = mintPaneId("p1");
    // tc-128.4: pane tracking is always-on; bind explicitly so the
    // accumulated bytes actually reach the draining transport (and the
    // drain credit fires when the consumer unpauses).
    demux.notifyPaneBound(paneId);
    const chunk = new Uint8Array(64 * 1024);

    // 1. Fill until paused.
    for (let i = 0; i < 200 && !fc.isPanePaused(paneId); i++) {
      accountingStore.append(paneId, chunk);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(fc.isPanePaused(paneId), true, "pre-condition: pane must be paused");

    const pausedBytes = fc.bufferedBytes(paneId);

    // 2. Resume the consumer side — bytes will drain, 'drain' will fire on
    //    the client socket, the noteDrained promise will resolve, fc counter
    //    falls below low-water, tmux is told to continue.
    for (const s of heldSockets) {
      s.on("data", () => { /* discard */ });
      s.resume();
    }

    // Wait for resume — generous timeout to allow the kernel to ack.
    const start = Date.now();
    while (fc.isPanePaused(paneId) && (Date.now() - start) < 5_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      fc.isPanePaused(paneId),
      false,
      `pane must resume within 5s of consumer recovery; ` +
      `bufferedBytes=${fc.bufferedBytes(paneId)} pausedAt=${pausedBytes}`,
    );

    // The host must have received a continue command.
    const continueCmd = writes.find((w) => w.includes(":continue"));
    assert.ok(
      continueCmd !== undefined,
      `fake host must have received a continue command after drain (got ${writes.length} writes)`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: tc-2ztp — Ctrl-C-after-firehose drain-path wedge
// ---------------------------------------------------------------------------
//
// Distinct from tc-7xv.24 (which fixed the PAUSE side: real backpressure now
// engages tmux pause). tc-2ztp is a RESUME-side wedge surfaced by ioTorture:
// after a high-throughput firehose pauses the pane, the user hits Ctrl-C and
// the producer stops — but the prompt never returns and a follow-up
// `echo DRAIN_OK` never appears: the pane is wedged permanently.
//
// Mechanism: once the pane is paused, every subsequent %output append is
// DROPPED by the demux gate (output-demux's append returns early for a paused
// pane — no fan-out, no resume-time flush). The production accounting wrapper
// (session-proxy.ts) calls fc.onPaneBytes for those bytes (FC-4), but because
// they never reach any transport's sendData, the draining wrapper never
// credits fc.noteDrained for them. They permanently inflate the resume-gating
// MAX above LOW_WATER. After Ctrl-C the genuinely-buffered bytes drain and
// credit, but the phantom gate-dropped bytes pin the MAX → fc never crosses
// the resume edge → tmux is never told to continue → frozen terminal.
//
// The crucial difference from the tc-7xv.24 suite above: those tests append
// straight through baseStore (bypassing the demux gate), so while-paused bytes
// are still fanned out and still credited — the gate-drop divergence never
// shows. This suite drives the FULL production path: account-then-gate via
// demux.store.append, so paused appends are actually dropped. It then stops
// the producer (SIGINT) and asserts the pane still resumes.
//
// The fix (tc-2ztp, flow-control.ts): onPaneBytes does not retain bytes that
// arrive while already paused, and clamps the crossing chunk's overshoot back
// to HIGH_WATER — so "buffered" only ever counts bytes actually owed to a
// transport, the only quantity the resume edge can clear.
// ---------------------------------------------------------------------------

describe("tc-2ztp Ctrl-C-after-firehose — drain path resumes after producer stops", () => {
  it("a firehose that pauses, then a producer stop, still resumes on consumer drain", async () => {
    const sockPath = tmpSocketPath("ctrlc");
    const heldSockets: net.Socket[] = [];

    // Slow consumer: accept but pause reads, so the firehose forces tmux pause.
    const server = net.createServer((sock) => {
      sock.pause();
      heldSockets.push(sock);
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    after(async () => {
      for (const s of heldSockets) { try { s.destroy(); } catch { /* ignore */ } }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    });

    const clientTransport = await connectSocketTransport(sockPath);
    after(() => clientTransport.close());

    const { writes, send } = makeFakeSend();
    const demux = createOutputDemux();
    const fc = createFlowController(send, demux);
    // Register the client so per-client accounting matches production (tc-0wtb).
    fc.addClient(clientTransport);

    // Production-shaped accounting store (session-proxy.ts step 4): COUNT then
    // APPEND, where APPEND goes through demux.store — whose gate DROPS bytes for
    // a paused pane. This is the path the tc-7xv.24 suite above does NOT model.
    const accountingStore = {
      append(pid: PaneId, bytes: Uint8Array): void {
        if (bytes.length > 0) fc.onPaneBytes(pid, bytes.length);
        demux.store.append(pid, bytes);
      },
      getContents: demux.store.getContents.bind(demux.store),
      size: demux.store.size.bind(demux.store),
      drop: demux.store.drop.bind(demux.store),
      clear: demux.store.clear.bind(demux.store),
    };

    // Attach the draining transport (credits THIS client's sub-ledger).
    const drainingTransport: Transport = {
      ...clientTransport,
      sendData(pid: PaneId, bytes: Uint8Array): void | Promise<void> {
        const result = clientTransport.sendData(pid, bytes);
        if (bytes.length === 0) return result;
        if (result !== undefined && typeof (result as Promise<void>).then === "function") {
          return (result as Promise<void>).then(() => {
            fc.noteDrained(pid, bytes.length, clientTransport);
          });
        }
        fc.noteDrained(pid, bytes.length, clientTransport);
        return undefined;
      },
    };
    demux.attachTransport(drainingTransport);

    const paneId = mintPaneId("p1");
    demux.notifyPaneBound(paneId);
    const chunk = new Uint8Array(64 * 1024); // 64 KiB

    // 1. FIREHOSE: pump until the pane pauses, then a few more chunks to model
    //    the FC-5 in-flight window (output tmux flushed before honoring pause).
    //    These post-pause appends are gate-dropped by the demux.
    let paused = false;
    for (let i = 0; i < 200; i++) {
      accountingStore.append(paneId, chunk);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (fc.isPanePaused(paneId)) { paused = true; break; }
    }
    assert.equal(paused, true, "firehose must pause the pane");
    // A handful of in-flight appends AFTER the pause — these are the bytes the
    // demux drops; pre-fix they accumulated as un-creditable phantom backlog.
    for (let i = 0; i < 8; i++) {
      accountingStore.append(paneId, chunk);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // 2. CTRL-C: the producer stops. No further appends. (In ioTorture this is
    //    the SIGINT that kills `seq`.)

    // 3. The consumer recovers (VS Code starts reading again).
    for (const s of heldSockets) {
      s.on("data", () => { /* discard */ });
      s.resume();
    }

    // 4. The pane MUST resume within a bounded time — the buffered bytes that
    //    were actually sent drain and credit, and (post-fix) no phantom
    //    gate-dropped bytes pin the MAX above low-water.
    const start = Date.now();
    while (fc.isPanePaused(paneId) && (Date.now() - start) < 5_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      fc.isPanePaused(paneId),
      false,
      `pane must resume after Ctrl-C + consumer drain — a permanent pause here is ` +
      `the tc-2ztp wedge (bufferedBytes=${fc.bufferedBytes(paneId)}). The gate-dropped ` +
      `in-flight bytes must NOT pin the resume edge.`,
    );

    // tmux must have been told to continue (the prompt-returns / DRAIN_OK path).
    const continueCmd = writes.find((w) => w.includes(":continue"));
    assert.ok(
      continueCmd !== undefined,
      `fake host must receive a continue command after Ctrl-C drain (got writes: ${JSON.stringify(writes)})`,
    );
  });
});
