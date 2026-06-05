/**
 * socket-transport.test.ts — unit tests for SocketTransport.
 *
 * Tests the control-plane framing (0xCB + u32be len + JSON) and verifies that
 * the transport correctly routes messages between two ends of an in-process
 * socket pair.
 *
 * @module socket-transport.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import { createSocketTransport, connectSocketTransport, createSocketServer } from "./socket-transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-transport-"));
  return path.join(dir, "test.sock");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("socket-transport", () => {
  it("round-trips a control-plane message between server and client", async () => {
    const sockPath = tmpSocketPath();
    const received: unknown[] = [];

    const server = await createSocketServer(sockPath, (transport) => {
      transport.onControl((msg) => {
        received.push(msg);
        // Echo back
        transport.sendControl({ ...msg, type: "echo.response" } as unknown as Parameters<typeof transport.sendControl>[0]);
      });
    });

    after(async () => {
      await server.close();
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    });

    const clientTransport = await connectSocketTransport(sockPath);

    const echoPromise = new Promise<unknown>((resolve) => {
      clientTransport.onControl((msg) => {
        if ((msg as unknown as { type: string }).type === "echo.response") resolve(msg);
      });
    });

    clientTransport.sendControl({ type: "test.ping", seq: 1 } as unknown as Parameters<typeof clientTransport.sendControl>[0]);

    const echoed = await echoPromise;
    assert.equal((echoed as unknown as { type: string }).type, "echo.response");
    assert.equal((echoed as unknown as { seq: number }).seq, 1);

    assert.equal(received.length, 1);
    assert.equal((received[0] as any).type, "test.ping");

    clientTransport.close();
  });

  it("handles close gracefully", async () => {
    const sockPath = tmpSocketPath();

    const server = await createSocketServer(sockPath, (transport) => {
      transport.onClose(() => {
        // server side sees close
      });
    });

    after(async () => {
      await server.close();
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    });

    const clientTransport = await connectSocketTransport(sockPath);
    const closePromise = new Promise<void>((resolve) => {
      clientTransport.onClose(() => resolve());
    });

    clientTransport.close();
    await closePromise;
  });

  it("handles large messages correctly", async () => {
    const sockPath = tmpSocketPath();
    const received: unknown[] = [];

    const server = await createSocketServer(sockPath, (transport) => {
      transport.onControl((msg) => received.push(msg));
    });

    after(async () => {
      await server.close();
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    });

    const clientTransport = await connectSocketTransport(sockPath);

    // Send a message with a large payload
    const bigPayload = "x".repeat(64_000);
    const donePromise = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (received.length >= 1) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    clientTransport.sendControl({ type: "big.msg", seq: 1, data: bigPayload } as unknown as Parameters<typeof clientTransport.sendControl>[0]);

    await donePromise;
    assert.equal(received.length, 1);
    assert.equal((received[0] as any).data, bigPayload);

    clientTransport.close();
  });
});
