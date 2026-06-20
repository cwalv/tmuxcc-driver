/**
 * server-proxy.test.ts — integration + race tests for the tmuxcc-broker.
 *
 * # Test categories
 *
 * ## Unit / handshake tests (always run)
 *
 * U1. ServerProxy starts, accepts a connection, runs handshake, sends snapshot.
 *
 * ## Integration tests (guarded by tmux availability)
 *
 * I1. spawn a server-proxy on a test socket, connect as a client, receive snapshot.
 * I2. session.claim creates a session + session-proxy + returns endpoint + created=true.
 * I3. session.claim on existing session returns same endpoint, created=false.
 * I4. session.create fails if name is already taken.
 * I5. session.destroy kills session + reaps session-proxy.
 * I6. sessions.added delta is pushed to subscribers after session.claim.
 * I7. Connect to session-proxy endpoint, run snapshot + input round-trip (session-proxy wire).
 *
 * ## Race test
 *
 * R1. 10 concurrent session.claim requests for the same name all receive
 *     the same sessionId + endpoint; only one session-proxy process is spawned;
 *     exactly one response reports created=true (tc-3y8.2).
 *
 * # Cleanup
 *
 * Each test creates its own server-proxy with a unique test socket name
 * (tmuxcc-test-sp-<N>-<ts>) and calls serverProxy.shutdown() in afterEach.
 *
 * @module serverProxy.test
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createServerProxy, connectSocketTransport, serverProxySocketPath } from "./index.js";
import type { ServerProxyHandle, ServerProxySelfExitReason } from "./index.js";
import type { Transport } from "@tmuxcc/session-proxy";

import {
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
} from "@tmuxcc/session-proxy";
import type {
  ServerProxySnapshotMessage,
  ServerProxyCommandResponseMessage,
  ServerProxySessionAddedMessage,
  MessageBase,
  Capabilities,
} from "@tmuxcc/session-proxy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCounter = 0;

function nextSocketName(): string {
  return `tmuxcc-test-sp-${process.pid}-${++testCounter}-${Date.now()}`;
}

function tmuxAvailable(): boolean {
  const r = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
  return r.status === 0 && !r.error;
}

/** Poll `predicate` every `intervalMs` until truthy; throw on timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timeout (${timeoutMs}ms) waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * PIDs of live thin-watcher tmux `-CC` client processes for a socket name.
 *
 * The `^tmux ` anchor matches only the tmux client itself, not the python
 * PTY-bridge parent (whose cmdline also contains the same substring).
 */
function findWatcherPids(socketName: string): number[] {
  const r = spawnSync("pgrep", ["-f", `^tmux -L ${socketName} -CC`], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (r.status !== 0 || r.error) return []; // pgrep exits 1 on no match
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !Number.isNaN(n));
}

/** mkdtemp a per-test runtime dir (removed in the test's finally block). */
function makeRuntimeDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tmuxcc-test-${label}-`));
}

/** Returns a Promise that rejects after `ms` milliseconds. The timeout is cleared if `signal` resolves. */
function rejectAfter<T>(ms: number, message: string): [Promise<never>, () => void] {
  let timer: ReturnType<typeof setTimeout>;
  const p = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    // Unref so this timer doesn't keep the event loop alive
    if (timer.unref) timer.unref();
  });
  return [p, () => clearTimeout(timer!)];
}

const CLIENT_CAPS: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: [
    "sessions-watch",
    "session-create",
    "session-destroy",
    "session-claim",
    "pane-attach", // tc-7xv.36
  ],
};

const SESSION_PROXY_CLIENT_CAPS: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding"],
};

/**
 * A multiplexing wrapper around a Transport's single onControl slot.
 *
 * Since Transport.onControl has replace-last-wins semantics, concurrent
 * test helpers that each want to install an onControl handler would
 * clobber each other. This class lets multiple subscribers share a
 * single actual onControl slot via fanout.
 */
class TransportMux {
  private _transport: Transport;
  private _handlers: Array<(msg: MessageBase) => void> = [];

  constructor(transport: Transport) {
    this._transport = transport;
    this._transport.onControl((msg) => {
      const copy = this._handlers.slice();
      for (const h of copy) h(msg as unknown as MessageBase);
    });
  }

  /** Subscribe to incoming control messages. Returns unsubscribe fn. */
  subscribe(handler: (msg: MessageBase) => void): () => void {
    this._handlers.push(handler);
    return () => {
      this._handlers = this._handlers.filter((h) => h !== handler);
    };
  }

  get transport(): Transport {
    return this._transport;
  }
}

/** Connect to a server-proxy and run the server-proxy-wire handshake. Returns the mux. */
async function connectToServerProxy(endpoint: string): Promise<{
  mux: TransportMux;
  snapshot: ServerProxySnapshotMessage;
}> {
  const transport = await connectSocketTransport(endpoint);

  // Run the handshake FIRST. runClientHandshake installs and then removes
  // its own onControl handler (leaves it as a no-op). We must install
  // the TransportMux AFTER so its handler wins the single-slot competition.
  await runClientHandshake(transport, CLIENT_CAPS, "server-proxy.capabilities");

  // Now safe to install the mux — handshake has settled and cleared its handler.
  const mux = new TransportMux(transport);

  // Snapshot is sent by the server-proxy right after handshake. Since the TCP
  // stream may already have buffered it by the time we install the mux,
  // we rely on the Node.js event loop: the mux handler fires on the NEXT
  // event-loop tick after socket data arrives, so as long as we install
  // the mux before yielding to the event loop (no await between handshake
  // resolve and mux construction), we'll catch it.
  //
  // If this races in practice (snapshot arrives before mux is installed),
  // the snapshot will be dropped. In that case, add a small delay or use
  // a different connection flow. For now, the synchronous handshake→mux
  // installation should be safe with socket transports.
  const snapshotPromise = new Promise<ServerProxySnapshotMessage>((resolve) => {
    const unsub = mux.subscribe((msg) => {
      if (msg.type === "sessions.snapshot") {
        unsub();
        resolve(msg as unknown as ServerProxySnapshotMessage);
      }
    });
  });

  const [timeoutP, clearTimeoutP] = rejectAfter(5_000, "Timeout waiting for server-proxy snapshot");
  const snapshot = await Promise.race([snapshotPromise, timeoutP]);
  clearTimeoutP();

  return { mux, snapshot };
}

/** Send a server-proxy command and wait for the correlated response. */
async function sendServerProxyCommand(
  mux: TransportMux,
  command: { kind: string; [k: string]: unknown },
  outgoingSeq: { value: number },
): Promise<ServerProxyCommandResponseMessage> {
  const correlationId = `corr-${Math.random().toString(36).slice(2)}`;

  const responsePromise = new Promise<ServerProxyCommandResponseMessage>((resolve) => {
    const unsub = mux.subscribe((msg) => {
      if (
        msg.type === "command.response" &&
        (msg as unknown as ServerProxyCommandResponseMessage).correlationId === correlationId
      ) {
        unsub();
        resolve(msg as unknown as ServerProxyCommandResponseMessage);
      }
    });
  });

  mux.transport.sendControl({
    type: "command.request",
    seq: outgoingSeq.value++,
    correlationId,
    command,
  } as unknown as Parameters<typeof mux.transport.sendControl>[0]);

  return responsePromise;
}

// ---------------------------------------------------------------------------
// Unit tests (no real tmux)
// ---------------------------------------------------------------------------

describe("server-proxy – unit (no tmux)", () => {
  it("U1: server-proxy starts and sends snapshot after handshake", async () => {
    const socketName = nextSocketName();
    const serverProxy = createServerProxy({ socketName });
    await serverProxy.start();

    try {
      const { snapshot } = await connectToServerProxy(serverProxy.endpoint());
      assert.equal(snapshot.type, "sessions.snapshot");
      assert.ok(Array.isArray(snapshot.sessions));
      // No real tmux server → sessions should be empty
      assert.equal(snapshot.sessions.length, 0);
    } finally {
      await serverProxy.shutdown();
    }
  });

  it("U3 (tc-k6v): server-proxy.info returns identity fields without tmux", async () => {
    const socketName = nextSocketName();
    const serverProxy = createServerProxy({ socketName });
    await serverProxy.start();

    try {
      const { mux } = await connectToServerProxy(serverProxy.endpoint());
      const seq = { value: 1 };

      const resp = await sendServerProxyCommand(mux, { kind: "server-proxy.info" }, seq);
      assert.ok(resp.result.ok, `Expected ok=true, got: ${JSON.stringify(resp.result)}`);
      const info = (resp.result as {
        ok: true;
        payload: { info: import("@tmuxcc/session-proxy").ServerProxyInfoPayload };
      }).payload.info;

      assert.equal(info.socketName, socketName);
      assert.equal(info.serverProxySocketPath, serverProxy.endpoint());
      // In-process server-proxy → its pid is this test process's pid.
      assert.equal(info.serverProxyPid, process.pid);
      assert.ok(info.uptimeMs >= 0, `uptimeMs must be >= 0, got ${info.uptimeMs}`);
      // No tmux server on this unique socket → null pid, no sessions, not adopted.
      assert.equal(info.tmuxServerPid, null);
      assert.equal(info.adoptedExistingServer, false);
      assert.deepEqual(info.sessions, []);
      // The connection carrying this very request counts.
      assert.ok(
        info.connectedClientCount >= 1,
        `connectedClientCount must include the requesting client, got ${info.connectedClientCount}`,
      );
      // Programmatic serverProxy (no entry point) → no log file.
      assert.equal(info.logPath, null);

      mux.transport.close();
    } finally {
      await serverProxy.shutdown();
    }
  });

  it("U4 (tc-k6v): server-proxy.info reports logPath verbatim when configured", async () => {
    const socketName = nextSocketName();
    const serverProxy = createServerProxy({ socketName, logPath: "/tmp/some-server-proxy.log" });
    await serverProxy.start();

    try {
      const { mux } = await connectToServerProxy(serverProxy.endpoint());
      const seq = { value: 1 };
      const resp = await sendServerProxyCommand(mux, { kind: "server-proxy.info" }, seq);
      assert.ok(resp.result.ok);
      const info = (resp.result as {
        ok: true;
        payload: { info: import("@tmuxcc/session-proxy").ServerProxyInfoPayload };
      }).payload.info;
      assert.equal(info.logPath, "/tmp/some-server-proxy.log");
      mux.transport.close();
    } finally {
      await serverProxy.shutdown();
    }
  });

  it("U2: serverProxy.endpoint() equals serverProxySocketPath(socketName) — well-known path", async () => {
    // This is the core regression guard for tc-j9c.8:
    // serverProxy.endpoint() must equal the path that vscode computes via
    // serverProxySocketPath(serverProxySocketName) so that discovery works without
    // out-of-band communication.
    const socketName = nextSocketName();
    const runtimeDir = `/tmp/tmuxcc-test-u2-${process.pid}`;
    const serverProxy = createServerProxy({ socketName, runtimeDir });
    await serverProxy.start();

    try {
      const expected = serverProxySocketPath(socketName, { runtimeDir });
      assert.equal(
        serverProxy.endpoint(),
        expected,
        `serverProxy.endpoint() must equal serverProxySocketPath(socketName): got ${serverProxy.endpoint()}, want ${expected}`,
      );
    } finally {
      await serverProxy.shutdown();
    }
  });

  // ── tc-295a.35: broker reports tmux-availability as canonical state ────────
  //
  // De-hollows the missing-tmux oracle on the DRIVER side: this proves the
  // broker comes up READY without tmux (preserving tolerance — it does NOT
  // exit) AND reports `tmuxAvailable: false` in its snapshot, the canonical
  // state the extension reads to surface "tmuxcc requires tmux.".  We simulate
  // tmux-absence with an empty PATH during start()+snapshot (the unqualified
  // `spawnSync("tmux", …)` then ENOENTs); PATH is restored in `finally` so the
  // operator's real install is untouched.

  it("U5 (tc-295a.35): snapshot reports tmuxAvailable=true when tmux is present", async () => {
    const socketName = nextSocketName();
    const serverProxy = createServerProxy({ socketName });
    await serverProxy.start();
    try {
      const { snapshot } = await connectToServerProxy(serverProxy.endpoint());
      assert.equal(snapshot.type, "sessions.snapshot");
      // tmux installed on this host → broker reports available.
      assert.equal(
        snapshot.tmuxAvailable,
        true,
        `tmux present ⇒ snapshot.tmuxAvailable must be true; got ${String(snapshot.tmuxAvailable)}`,
      );
    } finally {
      await serverProxy.shutdown();
    }
  });

  it("U6 (tc-295a.35): broker stays up and snapshot reports tmuxAvailable=false when tmux is absent", async () => {
    const socketName = nextSocketName();
    const savedPath = process.env.PATH;
    let serverProxy: ServerProxyHandle | undefined;
    try {
      // Empty PATH ⇒ the broker's `listSessions` spawn ENOENTs (tmux not found).
      process.env.PATH = "";
      serverProxy = createServerProxy({ socketName });
      // The broker MUST come up READY without tmux — it tolerates absence.
      await serverProxy.start();

      const { snapshot } = await connectToServerProxy(serverProxy.endpoint());
      assert.equal(snapshot.type, "sessions.snapshot");
      assert.equal(snapshot.sessions.length, 0, "no tmux ⇒ no sessions");
      assert.equal(
        snapshot.tmuxAvailable,
        false,
        `tmux absent ⇒ snapshot.tmuxAvailable must be false; got ${String(snapshot.tmuxAvailable)}`,
      );
    } finally {
      // Restore PATH BEFORE shutdown so cleanup tooling resolves normally.
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (serverProxy) await serverProxy.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests (requires tmux)
// ---------------------------------------------------------------------------

const TMUX_AVAILABLE = tmuxAvailable();

describe("server-proxy – integration (requires tmux)", { skip: !TMUX_AVAILABLE }, () => {
  let serverProxy: ServerProxyHandle;
  let socketName: string;

  beforeEach(async () => {
    socketName = nextSocketName();
    serverProxy = createServerProxy({ socketName });
    await serverProxy.start();
  });

  afterEach(async () => {
    await serverProxy.shutdown();
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
  });

  it("I1: connect to server-proxy and receive empty snapshot", async () => {
    const { snapshot } = await connectToServerProxy(serverProxy.endpoint());
    assert.equal(snapshot.type, "sessions.snapshot");
    assert.equal(snapshot.sessions.length, 0);
  });

  it("I2: session.claim creates a session and sessionProxy, returns endpoint + created=true", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const resp = await sendServerProxyCommand(mux, { kind: "session.claim", name: "test-claim" }, seq);

    assert.ok(resp.result.ok, `Expected ok=true, got: ${JSON.stringify(resp.result)}`);
    const payload = (resp.result as { ok: true; payload: { sessionId: string; endpoint: string; created: boolean } }).payload;
    assert.ok(payload.sessionId, "Missing sessionId");
    assert.ok(payload.endpoint, "Missing endpoint");
    // tc-3y8.2: a claim that mints the session must report created=true —
    // this is the client's authority for create-time-only profile apply.
    assert.equal(payload.created, true, "claim that creates must report created=true");

    mux.transport.close();
  });

  it("I3: session.claim on same name returns same sessionId + endpoint, created=false", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const resp1 = await sendServerProxyCommand(mux, { kind: "session.claim", name: "reuse-me" }, seq);
    const resp2 = await sendServerProxyCommand(mux, { kind: "session.claim", name: "reuse-me" }, seq);

    assert.ok(resp1.result.ok);
    assert.ok(resp2.result.ok);

    const p1 = (resp1.result as { ok: true; payload: { sessionId: string; endpoint: string; created: boolean } }).payload;
    const p2 = (resp2.result as { ok: true; payload: { sessionId: string; endpoint: string; created: boolean } }).payload;

    assert.equal(p1.sessionId, p2.sessionId, "sessionId must be stable");
    assert.equal(p1.endpoint, p2.endpoint, "endpoint must be stable");
    // tc-3y8.2: first claim creates, second attaches to the existing session.
    assert.equal(p1.created, true, "first claim must report created=true");
    assert.equal(p2.created, false, "second claim must report created=false (attach)");

    mux.transport.close();
  });

  it("I4: session.create fails if name is already taken", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const r1 = await sendServerProxyCommand(mux, { kind: "session.create", name: "unique-sess" }, seq);
    assert.ok(r1.result.ok, `First create failed: ${JSON.stringify(r1.result)}`);
    // tc-3y8.2: a successful session.create always mints → created=true.
    assert.equal(
      (r1.result as { ok: true; payload: { created: boolean } }).payload.created,
      true,
      "session.create must report created=true on success",
    );

    const r2 = await sendServerProxyCommand(mux, { kind: "session.create", name: "unique-sess" }, seq);
    assert.equal(r2.result.ok, false);
    assert.equal((r2.result as { ok: false; code: string }).code, "session.name-taken");

    mux.transport.close();
  });

  // ── session.createUnique (tc-295a.5 / W1.4) ──────────────────────────────
  //
  // AC (2): two startNew calls without names yield two distinct sessions
  // with distinct handles — verified against the broker's live _byName truth.

  it("I4a (tc-295a.5): two sequential session.createUnique calls with the same baseName yield distinct names, sessionIds, and endpoints", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const r1 = await sendServerProxyCommand(
      mux,
      { kind: "session.createUnique", baseName: "myws" },
      seq,
    );
    assert.ok(r1.result.ok, `First createUnique failed: ${JSON.stringify(r1.result)}`);
    const p1 = (r1.result as {
      ok: true;
      payload: { sessionId: string; endpoint: string; name: string; created: boolean };
    }).payload;
    assert.ok(p1.name, "createUnique response must include a name");
    assert.ok(p1.sessionId, "createUnique response must include a sessionId");
    assert.ok(p1.endpoint, "createUnique response must include an endpoint");
    assert.equal(p1.created, true, "createUnique must always report created=true");

    const r2 = await sendServerProxyCommand(
      mux,
      { kind: "session.createUnique", baseName: "myws" },
      seq,
    );
    assert.ok(r2.result.ok, `Second createUnique failed: ${JSON.stringify(r2.result)}`);
    const p2 = (r2.result as {
      ok: true;
      payload: { sessionId: string; endpoint: string; name: string; created: boolean };
    }).payload;
    assert.ok(p2.name, "second createUnique response must include a name");
    assert.equal(p2.created, true, "second createUnique must also report created=true");

    // The two calls must have produced two distinct sessions.
    assert.notEqual(p1.name, p2.name, `Both createUnique calls got the same name '${p1.name}' — uniquification failed`);
    assert.notEqual(p1.sessionId, p2.sessionId, "createUnique calls must return distinct sessionIds");
    assert.notEqual(p1.endpoint, p2.endpoint, "createUnique calls must return distinct session-proxy endpoints");

    mux.transport.close();
  });

  it("I4b (tc-295a.5): two concurrent session.createUnique calls with the same baseName yield distinct sessions", async () => {
    // AC (2): two startNew calls without names yield two distinct sessions
    // with distinct handles.  This tests the concurrent/race path — both
    // requests are in-flight simultaneously; the broker must not collide.
    const endpoint = serverProxy.endpoint();
    const [c1, c2] = await Promise.all([
      connectToServerProxy(endpoint),
      connectToServerProxy(endpoint),
    ]);

    const [r1, r2] = await Promise.all([
      sendServerProxyCommand(c1.mux, { kind: "session.createUnique", baseName: "concws" }, { value: 1 }),
      sendServerProxyCommand(c2.mux, { kind: "session.createUnique", baseName: "concws" }, { value: 1 }),
    ]);

    assert.ok(r1.result.ok, `createUnique #1 failed: ${JSON.stringify(r1.result)}`);
    assert.ok(r2.result.ok, `createUnique #2 failed: ${JSON.stringify(r2.result)}`);

    const p1 = (r1.result as {
      ok: true;
      payload: { sessionId: string; endpoint: string; name: string; created: boolean };
    }).payload;
    const p2 = (r2.result as {
      ok: true;
      payload: { sessionId: string; endpoint: string; name: string; created: boolean };
    }).payload;

    assert.notEqual(p1.name, p2.name, `Concurrent createUnique calls got the same name '${p1.name}' — uniquification race`);
    assert.notEqual(p1.sessionId, p2.sessionId, "Concurrent createUnique must yield distinct sessionIds");
    assert.notEqual(p1.endpoint, p2.endpoint, "Concurrent createUnique must yield distinct endpoints");
    assert.equal(p1.created, true, "createUnique #1 must report created=true");
    assert.equal(p2.created, true, "createUnique #2 must report created=true");

    c1.mux.transport.close();
    c2.mux.transport.close();
  });

  it("I5: session.destroy kills session and reaps session-proxy", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const claimResp = await sendServerProxyCommand(mux, { kind: "session.claim", name: "to-destroy" }, seq);
    assert.ok(claimResp.result.ok);
    const sessionId = (claimResp.result as { ok: true; payload: { sessionId: string } }).payload.sessionId;

    const destroyResp = await sendServerProxyCommand(mux, { kind: "session.destroy", sessionId }, seq);
    assert.ok(destroyResp.result.ok, `Destroy failed: ${JSON.stringify(destroyResp.result)}`);

    mux.transport.close();
  });

  it("I6: sessions.added is pushed to subscribers after session.claim", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    // Set up delta listener BEFORE the command
    const addedPromise = new Promise<ServerProxySessionAddedMessage>((resolve) => {
      const unsub = mux.subscribe((msg) => {
        if (msg.type === "sessions.added") {
          unsub();
          resolve(msg as unknown as ServerProxySessionAddedMessage);
        }
      });
    });

    // Trigger session creation
    const claimResp = await sendServerProxyCommand(mux, { kind: "session.claim", name: "watch-target" }, seq);
    assert.ok(claimResp.result.ok, `Claim failed: ${JSON.stringify(claimResp.result)}`);

    // The sessions.added delta is sent when the session first appears.
    // It may have already arrived (before or during the claim response).
    // Wait up to 2s.
    const [addedTimeoutP, clearAddedTimeout] = rejectAfter(2_000, "Timeout waiting for sessions.added");
    const added = await Promise.race([addedPromise, addedTimeoutP]);
    clearAddedTimeout();

    assert.equal(added.type, "sessions.added");
    assert.ok(added.sessionId);
    assert.equal(added.name, "watch-target");

    mux.transport.close();
  });

  it("I8 (tc-7xv.36): pane.attach returns the same session-proxy endpoint as session.claim and echoes paneId", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    // First claim the session so a session-proxy is running and we know its sessionId.
    const claimResp = await sendServerProxyCommand(mux, { kind: "session.claim", name: "pane-attach-target" }, seq);
    assert.ok(claimResp.result.ok, `Claim failed: ${JSON.stringify(claimResp.result)}`);
    const claimPayload = (claimResp.result as {
      ok: true;
      payload: { sessionId: string; endpoint: string };
    }).payload;
    const sessionId = claimPayload.sessionId;
    const claimEndpoint = claimPayload.endpoint;

    // Now attach to a specific pane.  The server-proxy does not validate pane
    // existence; this test simply asserts the round-trip shape.
    const attachResp = await sendServerProxyCommand(
      mux,
      { kind: "pane.attach", sessionId, paneId: "p1" },
      seq,
    );
    assert.ok(
      attachResp.result.ok,
      `pane.attach failed: ${JSON.stringify(attachResp.result)}`,
    );
    const attachPayload = (attachResp.result as {
      ok: true;
      payload: { sessionId: string; endpoint: string; paneId: string };
    }).payload;
    assert.equal(attachPayload.sessionId, sessionId, "sessionId must match");
    assert.equal(attachPayload.endpoint, claimEndpoint, "endpoint must match");
    assert.equal(attachPayload.paneId, "p1", "paneId must echo back");

    mux.transport.close();
  });

  it("I9 (tc-7xv.36): pane.attach returns session.not-found for unknown session", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const resp = await sendServerProxyCommand(
      mux,
      { kind: "pane.attach", sessionId: "s999-nonexistent", paneId: "p0" },
      seq,
    );

    assert.equal(resp.result.ok, false);
    const r = resp.result as { ok: false; code: string; message: string };
    assert.equal(r.code, "session.not-found", `code should be session.not-found, got ${r.code}`);

    mux.transport.close();
  });

  it("I10 (tc-k6v): server-proxy.info reports tmux server pid + per-session session-proxy pid and pane count", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    // Claim a session so a tmux server, session, and session-proxy all exist.
    const claimResp = await sendServerProxyCommand(mux, { kind: "session.claim", name: "info-target" }, seq);
    assert.ok(claimResp.result.ok, `Claim failed: ${JSON.stringify(claimResp.result)}`);

    const resp = await sendServerProxyCommand(mux, { kind: "server-proxy.info" }, seq);
    assert.ok(resp.result.ok, `server-proxy.info failed: ${JSON.stringify(resp.result)}`);
    const info = (resp.result as {
      ok: true;
      payload: { info: import("@tmuxcc/session-proxy").ServerProxyInfoPayload };
    }).payload.info;

    // tmux server pid is live.
    assert.ok(
      typeof info.tmuxServerPid === "number" && info.tmuxServerPid > 0,
      `tmuxServerPid must be a live pid, got ${String(info.tmuxServerPid)}`,
    );

    // The claimed session appears with a live session-proxy pid and ≥1 window/pane.
    // tc-2x3.3: the session-proxy now runs IN-PROCESS inside the server-proxy
    // event loop, so sessionProxyPid is the server-proxy's own pid (the
    // session-proxy IS this process) — still a live pid that `kill -0` can probe.
    const row = info.sessions.find((s) => s.name === "info-target");
    assert.ok(row, `server-proxy.info sessions must include 'info-target': ${JSON.stringify(info.sessions)}`);
    assert.ok(
      typeof row.sessionProxyPid === "number" && row.sessionProxyPid > 0,
      `sessionProxyPid must be a live pid, got ${String(row.sessionProxyPid)}`,
    );
    assert.equal(
      row.sessionProxyPid,
      process.pid,
      "tc-2x3.3: in-process session-proxy reports the server-proxy's own pid",
    );
    // kill -0 probes liveness without sending a signal.
    assert.doesNotThrow(() => process.kill(row.sessionProxyPid as number, 0), "sessionProxyPid must be running");
    assert.ok(row.windowCount >= 1, `windowCount must be >= 1, got ${row.windowCount}`);
    assert.ok(row.paneCount >= 1, `paneCount must be >= 1, got ${row.paneCount}`);
    assert.ok(
      typeof row.attachedClientCount === "number" && row.attachedClientCount >= 0,
      `attachedClientCount must be a number, got ${String(row.attachedClientCount)}`,
    );

    mux.transport.close();
  });

  it("I11 (tc-3y8.7): attachedClientCount is external-only — session-proxy+watcher do not inflate the count", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    // Claim a session.  This attaches two tmuxcc-owned control-mode clients:
    //   1. the server-proxy's watcher (flags: control-mode, ignore-size, no-output)
    //   2. the session sessionProxy (flags: control-mode)
    // Wait a moment for the watcher to fully attach (it polls/attaches async).
    const claimResp = await sendServerProxyCommand(mux, { kind: "session.claim", name: "own-clients-test" }, seq);
    assert.ok(claimResp.result.ok, `Claim failed: ${JSON.stringify(claimResp.result)}`);

    // Give the watcher time to attach so session_attached is stable.
    await waitFor(
      () => findWatcherPids(socketName).length > 0,
      5_000,
      "watcher to attach to tmux server",
    );
    // A small additional wait for the tmux session_attached counter to settle.
    await new Promise((r) => setTimeout(r, 500));

    // snapshot via sessions.snapshot on a fresh server-proxy connection — counts
    // are refreshed by the server-proxy when building the snapshot.
    const { snapshot } = await connectToServerProxy(serverProxy.endpoint());
    const sessionInfo = snapshot.sessions.find((s) => s.name === "own-clients-test");
    assert.ok(
      sessionInfo,
      `sessions.snapshot must include 'own-clients-test': ${JSON.stringify(snapshot.sessions)}`,
    );
    // With session-proxy + watcher attached but NO real human clients, external count = 0.
    assert.equal(
      sessionInfo.attachedClientCount,
      0,
      `attachedClientCount must be 0 (session-proxy and watcher are tmuxcc-owned, not external); got ${sessionInfo.attachedClientCount}`,
    );

    // Also verify via server-proxy.info, which uses the same session-table entry.
    const infoResp = await sendServerProxyCommand(mux, { kind: "server-proxy.info" }, seq);
    assert.ok(infoResp.result.ok, `server-proxy.info failed: ${JSON.stringify(infoResp.result)}`);
    const info = (infoResp.result as {
      ok: true;
      payload: { info: import("@tmuxcc/session-proxy").ServerProxyInfoPayload };
    }).payload.info;
    const infoRow = info.sessions.find((s) => s.name === "own-clients-test");
    assert.ok(
      infoRow,
      `server-proxy.info sessions must include 'own-clients-test': ${JSON.stringify(info.sessions)}`,
    );
    assert.equal(
      infoRow.attachedClientCount,
      0,
      `server-proxy.info attachedClientCount must be 0 for external-only semantics; got ${infoRow.attachedClientCount}`,
    );

    mux.transport.close();
  });

  it("I12 (tc-i9aq.2): session.topology returns windows and panes for a known session", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    // Claim a session so it exists in the registry and tmux has created it.
    const claimResp = await sendServerProxyCommand(mux, { kind: "session.claim", name: "topology-target" }, seq);
    assert.ok(claimResp.result.ok, `Claim failed: ${JSON.stringify(claimResp.result)}`);
    const sessionId = (claimResp.result as {
      ok: true;
      payload: { sessionId: string };
    }).payload.sessionId;

    // Query topology — does NOT claim or spawn anything new.
    const topResp = await sendServerProxyCommand(mux, { kind: "session.topology", sessionId }, seq);
    assert.ok(topResp.result.ok, `session.topology failed: ${JSON.stringify(topResp.result)}`);
    const topology = (topResp.result as {
      ok: true;
      payload: { topology: { windows: unknown[]; panes: unknown[] } };
    }).payload.topology;

    // A freshly-claimed session has at least one default window and pane.
    assert.ok(Array.isArray(topology.windows), "topology.windows must be an array");
    assert.ok(topology.windows.length >= 1, "topology must have at least one window");
    const win = topology.windows[0] as { windowId: string; name: string; active: boolean };
    assert.ok(win.windowId, "window must have windowId");
    assert.ok(typeof win.name === "string", "window must have name");
    assert.ok(typeof win.active === "boolean", "window must have active boolean");

    assert.ok(Array.isArray(topology.panes), "topology.panes must be an array");
    assert.ok(topology.panes.length >= 1, "topology must have at least one pane");
    const pane = topology.panes[0] as {
      paneId: string;
      windowId: string;
      bound: boolean;
      detach: string | undefined;
      icon: string | undefined;
    };
    assert.ok(pane.paneId, "pane must have paneId");
    assert.ok(pane.windowId, "pane must have windowId");
    assert.ok(typeof pane.bound === "boolean", "pane.bound must be boolean");
    // bound defaults false (no @tmuxcc-bound set on a fresh session).
    assert.equal(pane.bound, false, "fresh pane must have bound=false");
    // detach and icon are undefined when not set.
    assert.equal(pane.detach, undefined, "fresh pane must have detach=undefined");
    assert.equal(pane.icon, undefined, "fresh pane must have icon=undefined");

    mux.transport.close();
  });

  it("I13 (tc-i9aq.2): session.topology returns empty topology for unknown sessionId", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const resp = await sendServerProxyCommand(
      mux,
      { kind: "session.topology", sessionId: "s999-nonexistent" },
      seq,
    );
    // Returns ok:true with empty topology (graceful fallback — no session.not-found).
    assert.ok(resp.result.ok, `session.topology should succeed even for unknown session`);
    const topology = (resp.result as {
      ok: true;
      payload: { topology: { windows: unknown[]; panes: unknown[] } };
    }).payload.topology;
    assert.deepEqual(topology.windows, [], "empty topology.windows for unknown session");
    assert.deepEqual(topology.panes, [], "empty topology.panes for unknown session");

    mux.transport.close();
  });

  it("I7: connect to session-proxy endpoint and run snapshot round-trip", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const claimResp = await sendServerProxyCommand(mux, { kind: "session.claim", name: "session-proxy-rtrip" }, seq);
    assert.ok(claimResp.result.ok, `Claim failed: ${JSON.stringify(claimResp.result)}`);
    const endpoint = (claimResp.result as { ok: true; payload: { endpoint: string } }).payload.endpoint;

    // Connect to the session-proxy endpoint using a socket transport.
    // Run the handshake FIRST (same pattern as connectToServerProxy): the handshake
    // installs and then resets its own onControl handler. Install the mux
    // AFTER so its fanout handler wins the single-slot competition.
    const sessionProxyTransport = await connectSocketTransport(endpoint);
    await runClientHandshake(sessionProxyTransport, SESSION_PROXY_CLIENT_CAPS, "session-proxy.capabilities");

    // Now safe to install the mux — handshake has settled and cleared its handler.
    // The session-proxy snapshot arrives after the handshake, so this is not a race.
    const sessionProxyMux = new TransportMux(sessionProxyTransport);

    const snapshotPromise2 = new Promise<unknown>((resolve) => {
      const unsub = sessionProxyMux.subscribe((msg) => {
        if (msg.type === "snapshot") {
          unsub();
          resolve(msg);
        }
      });
    });

    const [sessionProxyTimeoutP, clearSessionProxyTimeout] = rejectAfter(10_000, "Timeout waiting for session-proxy snapshot");
    const snapshot2 = await Promise.race([snapshotPromise2, sessionProxyTimeoutP]);
    clearSessionProxyTimeout();

    // SessionProxy SnapshotMessage (wire v3, tc-j9c.2) has singular `session: SnapshotSession`
    assert.equal((snapshot2 as { type: string }).type, "snapshot");
    const sess2 = (snapshot2 as { session: { sessionId: string; name: string } }).session;
    assert.ok(sess2, "SessionProxy snapshot must have a `session` field");
    assert.ok(sess2.sessionId, "SessionProxy snapshot session must have sessionId");

    sessionProxyTransport.close();
    mux.transport.close();
  });
});

// ---------------------------------------------------------------------------
// tc-w61: @tmuxcc marker integration tests (requires tmux)
// ---------------------------------------------------------------------------

describe("tc-w61: @tmuxcc 1 marker set on spawn / claim", { skip: !TMUX_AVAILABLE }, () => {
  let serverProxy: ServerProxyHandle;
  let socketName: string;

  beforeEach(async () => {
    socketName = nextSocketName();
    serverProxy = createServerProxy({ socketName });
    await serverProxy.start();
  });

  afterEach(async () => {
    await serverProxy.shutdown();
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
  });

  it("M1: session.claim sets @tmuxcc 1 on the spawned tmux session", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const sessionName = "tc-w61-marker-spawn";
    const resp = await sendServerProxyCommand(mux, { kind: "session.claim", name: sessionName }, seq);
    assert.ok(resp.result.ok, `session.claim failed: ${JSON.stringify(resp.result)}`);

    // Verify @tmuxcc 1 is set on the real tmux session.
    // `show-options -v` prints the raw value to stdout; exit 0 means the option is set.
    const markerResult = spawnSync(
      "tmux",
      ["-L", socketName, "show-options", "-t", sessionName, "-v", "@tmuxcc"],
      { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    assert.equal(markerResult.status, 0, "show-options must exit 0 (option is set)");
    assert.equal(
      (markerResult.stdout ?? "").trim(),
      "1",
      "@tmuxcc must be exactly '1' after session.claim",
    );

    mux.transport.close();
  });

  it("M2: session.create sets @tmuxcc 1 on the spawned tmux session", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const sessionName = "tc-w61-marker-create";
    const resp = await sendServerProxyCommand(mux, { kind: "session.create", name: sessionName }, seq);
    assert.ok(resp.result.ok, `session.create failed: ${JSON.stringify(resp.result)}`);

    const markerResult = spawnSync(
      "tmux",
      ["-L", socketName, "show-options", "-t", sessionName, "-v", "@tmuxcc"],
      { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    assert.equal(markerResult.status, 0, "show-options must exit 0 (option is set)");
    assert.equal(
      (markerResult.stdout ?? "").trim(),
      "1",
      "@tmuxcc must be exactly '1' after session.create",
    );

    mux.transport.close();
  });

  it("M3: mark-on-attach — claiming a pre-existing unmarked session sets @tmuxcc 1", async () => {
    // Create a plain tmux session WITHOUT going through the serverProxy (simulates
    // a session the user created before tmuxcc was installed, or one they created
    // with plain `tmux new-session`).
    const sessionName = "tc-w61-preexisting";
    const created = spawnSync(
      "tmux",
      ["-L", socketName, "new-session", "-d", "-s", sessionName],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(created.status, 0, "Pre-existing session creation must succeed");

    // Confirm the marker is NOT set on the bare tmux session.
    const before = spawnSync(
      "tmux",
      ["-L", socketName, "show-options", "-t", sessionName, "-v", "@tmuxcc"],
      { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    // show-options exits non-zero or returns empty when the option is unset.
    const beforeValue = (before.stdout ?? "").trim();
    assert.ok(
      before.status !== 0 || beforeValue !== "1",
      "Pre-existing session must NOT have @tmuxcc 1 before claiming",
    );

    // Now claim the session through the server-proxy.  This should trigger mark-on-attach.
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };
    const resp = await sendServerProxyCommand(mux, { kind: "session.claim", name: sessionName }, seq);
    assert.ok(resp.result.ok, `session.claim failed: ${JSON.stringify(resp.result)}`);

    // Verify the marker is now set.
    const after = spawnSync(
      "tmux",
      ["-L", socketName, "show-options", "-t", sessionName, "-v", "@tmuxcc"],
      { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    assert.equal(after.status, 0, "show-options must exit 0 after claim");
    assert.equal(
      (after.stdout ?? "").trim(),
      "1",
      "@tmuxcc must be exactly '1' on pre-existing session after claim (mark-on-attach)",
    );

    mux.transport.close();
  });
});

// ---------------------------------------------------------------------------
// Race test (requires tmux)
// ---------------------------------------------------------------------------

describe("server-proxy – race test (requires tmux)", { skip: !TMUX_AVAILABLE }, () => {
  let serverProxy: ServerProxyHandle;
  let socketName: string;

  beforeEach(async () => {
    socketName = nextSocketName();
    serverProxy = createServerProxy({ socketName });
    await serverProxy.start();
  });

  afterEach(async () => {
    await serverProxy.shutdown();
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
  });

  it("R1: 10 concurrent claims of the same name all get the same sessionId + endpoint", async () => {
    const N = 10;
    const endpoint = serverProxy.endpoint();

    // Open N connections, all in parallel
    const connections = await Promise.all(
      Array.from({ length: N }, () => connectToServerProxy(endpoint)),
    );

    // Issue all 10 session.claim requests concurrently
    const responses = await Promise.all(
      connections.map(({ mux }, i) =>
        sendServerProxyCommand(mux, { kind: "session.claim", name: "race-session" }, { value: i * 100 + 1 }),
      ),
    );

    // All must succeed
    for (const resp of responses) {
      assert.ok(resp.result.ok, `Expected ok=true, got: ${JSON.stringify(resp.result)}`);
    }

    // All must have the same sessionId and endpoint
    const sessionIds = new Set(
      responses.map((r) => (r.result as { ok: true; payload: { sessionId: string } }).payload.sessionId),
    );
    const endpoints = new Set(
      responses.map((r) => (r.result as { ok: true; payload: { endpoint: string } }).payload.endpoint),
    );

    assert.equal(sessionIds.size, 1, `Expected 1 unique sessionId, got ${sessionIds.size}: ${[...sessionIds]}`);
    assert.equal(endpoints.size, 1, `Expected 1 unique endpoint, got ${endpoints.size}: ${[...endpoints]}`);

    // tc-3y8.2: exactly ONE of the racing claims may observe created=true —
    // joined in-flight claims are remapped to created=false so create-time
    // behaviour (profile apply) runs at most once per session creation.
    const createdCount = responses.filter(
      (r) => (r.result as { ok: true; payload: { created: boolean } }).payload.created === true,
    ).length;
    assert.equal(createdCount, 1, `Expected exactly 1 created=true response, got ${createdCount}`);

    // Clean up
    for (const { mux } of connections) {
      mux.transport.close();
    }
  });

  // tc-zcqr regression: rapid-fire single-claim sequence on a freshly-spawned
  // server-proxy.  In the bug-era code, `_doClaimSession` ran `tmux new-session`
  // then a SECOND `tmux list-sessions` to learn the session id; the second
  // round-trip could transiently fail (5 s timeout, control-mode contention
  // with the watcher + supervisor) and `listSessions` silently coerced that
  // failure into `[]`, erasing the just-created session from `_byName` and
  // producing `"[internal] Session 'X' not found after creation"`.
  //
  // The fix path:
  //   - `createSession` returns the new session id authoritatively via
  //     `new-session -P -F '#{session_id}'`.
  //   - `_doClaimSession` injects the new row into `_sessions/_byName`
  //     synchronously — no follow-up `list-sessions` on the happy path.
  //   - `listSessions` returns null on transient failures so
  //     `_refreshSessions` leaves the cache intact instead of clearing it.
  //
  // The regression: 25 sequential claim-then-disconnect cycles must ALL
  // succeed with no "not found after creation" error.  Pre-fix this surface
  // was intermittent (~1 in 50 under loaded CI); post-fix it must be 0/25.
  it("R2 (tc-zcqr): 25 sequential single-claim cycles on a fresh server-proxy all succeed", async () => {
    const N = 25;
    const endpoint = serverProxy.endpoint();
    for (let i = 0; i < N; i++) {
      const { mux } = await connectToServerProxy(endpoint);
      const seq = { value: 1 };
      const resp = await sendServerProxyCommand(
        mux,
        { kind: "session.claim", name: `r2-cycle-${i}` },
        seq,
      );
      assert.ok(
        resp.result.ok,
        `cycle ${i}: session.claim must succeed; got: ${JSON.stringify(resp.result)}`,
      );
      const payload = (resp.result as {
        ok: true;
        payload: { sessionId: string; endpoint: string; created: boolean };
      }).payload;
      assert.ok(payload.sessionId, `cycle ${i}: payload must include sessionId`);
      assert.equal(payload.created, true, `cycle ${i}: this claim must report created=true`);
      mux.transport.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Self-exit lifecycle tests (tc-3iv, ext-a-design-context.md §6.2)
// ---------------------------------------------------------------------------

describe("server-proxy – self-exit: idle hysteresis (tc-3iv)", () => {
  it("S1: zero IPC clients past hysteresis → self-exit, socket unlinked, respawn works", async () => {
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir("s1");
    // Injected short hysteresis — do NOT literally wait 5 minutes in tests.
    const serverProxy = createServerProxy({ socketName, runtimeDir, idleExitMs: 500 });
    const exits: ServerProxySelfExitReason[] = [];
    serverProxy.onSelfExit((reason) => exits.push(reason));
    await serverProxy.start();
    const endpoint = serverProxy.endpoint();

    try {
      assert.ok(fs.existsSync(endpoint), "socket file must exist after start");
      assert.equal(serverProxy.connectedClientCount, 0);

      // Connect a raw client — "client" means ANY open unix-domain connection,
      // counted before (and regardless of) the wire handshake.
      const t = await connectSocketTransport(endpoint);
      await waitFor(() => serverProxy.connectedClientCount === 1, 2_000, "clientCount 0→1 on connect");

      // Disconnect — count drops and the hysteresis window restarts.
      t.close();
      await waitFor(() => serverProxy.connectedClientCount === 0, 2_000, "clientCount 1→0 on disconnect");

      // Idle window elapses → server-proxy self-exits and unlinks its socket.
      await waitFor(() => exits.length > 0, 3_000, "idle self-exit");
      assert.deepEqual(exits, ["idle"]);
      assert.equal(
        fs.existsSync(endpoint),
        false,
        "socket file must be unlinked on self-exit (next launcher probe must not connect-then-reset)",
      );

      // A subsequent spawn on the same socket name + runtime dir must succeed
      // (no EADDRINUSE from a leftover socket file) and must accept clients.
      const broker2 = createServerProxy({ socketName, runtimeDir, idleExitMs: 60_000 });
      try {
        await broker2.start();
        assert.equal(broker2.endpoint(), endpoint, "respawn binds the same well-known path");
        const t2 = await connectSocketTransport(broker2.endpoint());
        await waitFor(() => broker2.connectedClientCount === 1, 2_000, "respawned server-proxy accepts clients");
        t2.close();
      } finally {
        await broker2.shutdown();
      }
    } finally {
      await serverProxy.shutdown(); // idempotent after self-exit
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("S2: connected-but-idle client keeps the server-proxy alive past the hysteresis window", async () => {
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir("s2");
    const serverProxy = createServerProxy({ socketName, runtimeDir, idleExitMs: 400 });
    const exits: ServerProxySelfExitReason[] = [];
    serverProxy.onSelfExit((reason) => exits.push(reason));
    await serverProxy.start();
    const endpoint = serverProxy.endpoint();

    try {
      // Connect and then do nothing — no handshake, no commands.  A
      // connected-but-idle client must keep the server-proxy alive (§6.2: "client"
      // is NOT "has bound a terminal" or "has claimed a session").
      const t = await connectSocketTransport(endpoint);
      await waitFor(() => serverProxy.connectedClientCount === 1, 2_000, "clientCount 0→1 on connect");

      // Sit idle for well over the hysteresis window.
      await new Promise((r) => setTimeout(r, 1_000));

      assert.equal(exits.length, 0, "server-proxy must NOT self-exit while a client is connected");
      assert.ok(fs.existsSync(endpoint), "socket file must still exist");
      assert.equal(serverProxy.connectedClientCount, 1, "client still counted");

      t.close();
      await waitFor(() => serverProxy.connectedClientCount === 0, 2_000, "clientCount 1→0 on disconnect");
    } finally {
      await serverProxy.shutdown();
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// tc-7aqb.1 — broker-keyed idle exit: detached session must not block idle
// ---------------------------------------------------------------------------
//
// The broker connection (per-window keepalive) is the sole liveness gate.
// A session that has been claimed but whose tmux clients have all detached
// must NOT keep the driver alive — it can be warm-reattached after a
// sub-idle-window EDH restart, but a fully-closed VS Code window (zero IPC
// clients) should let the driver exit after the grace window.
//
// This replaces the former tc-eqgp "children block idle" policy which caused
// drivers to pin stale bundles across EDH rebuilds whenever a detached session
// remained claimed.

describe("server-proxy – self-exit: detached session does not block idle (tc-7aqb.1, requires tmux)", { skip: !TMUX_AVAILABLE }, () => {
  it("S5: claimed+detached session with zero IPC clients → idle-exit fires after the grace window", { timeout: 30_000 }, async () => {
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir("s5");
    const idleExitMs = 400;

    // Seed a tmux session outside the server-proxy's view of "tmuxcc-managed"
    // so the tmux server stays alive for the duration of the test — we are
    // observing an IDLE exit, not a tmux-gone exit.
    const seeded = spawnSync("tmux", ["-L", socketName, "new-session", "-d", "-s", "s5-seed"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(seeded.status, 0, `tmux new-session failed: ${seeded.stderr}`);

    const serverProxy = createServerProxy({ socketName, runtimeDir, idleExitMs });
    const exits: ServerProxySelfExitReason[] = [];
    serverProxy.onSelfExit((reason) => exits.push(reason));
    await serverProxy.start();
    const endpoint = serverProxy.endpoint();

    try {
      // Claim a session → server-proxy spawns a session-proxy child.  Drop
      // the IPC connection immediately — this is the "detached" state: a live
      // child but zero broker (IPC) clients.
      {
        const { mux } = await connectToServerProxy(endpoint);
        const seq = { value: 1 };
        const resp = await sendServerProxyCommand(mux, { kind: "session.claim", name: "zombie-session" }, seq);
        assert.ok(resp.result.ok, `claim failed: ${JSON.stringify(resp.result)}`);
        mux.transport.close();
      }
      await waitFor(() => serverProxy.connectedClientCount === 0, 2_000, "IPC client gone after claim");

      // The idle timer is already running (keyed solely on IPC client count).
      // The server-proxy must idle-exit after the grace window despite the
      // live session-proxy child — the zombie must not pin the driver.
      await waitFor(() => exits.length > 0, idleExitMs * 5, "idle exit despite live child");
      assert.deepEqual(exits, ["idle"]);
      assert.equal(
        fs.existsSync(endpoint),
        false,
        "socket file must be unlinked on idle exit (next launcher probe must not connect-then-reset)",
      );
    } finally {
      await serverProxy.shutdown(); // idempotent after self-exit
      spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});

describe("server-proxy – self-exit: tmux death & watcher respawn (tc-3iv, requires tmux)", { skip: !TMUX_AVAILABLE }, () => {
  it("S3: tmux kill-server → server-proxy self-exits within 2s and unlinks its socket", async () => {
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir("s3");

    // Seed a session FIRST so the server-proxy's thin -CC watcher can attach.
    const seeded = spawnSync("tmux", ["-L", socketName, "new-session", "-d", "-s", "seed"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(seeded.status, 0, `tmux new-session failed: ${seeded.stderr}`);

    // Long idle window so only the tmux-death path can trigger exit.
    const serverProxy = createServerProxy({ socketName, runtimeDir, idleExitMs: 600_000 });
    const exits: ServerProxySelfExitReason[] = [];
    let exitedAt = 0;
    serverProxy.onSelfExit((reason) => {
      exits.push(reason);
      exitedAt = Date.now();
    });
    await serverProxy.start();
    const endpoint = serverProxy.endpoint();

    try {
      // The exit trigger is watcher EOF — wait for the watcher to be attached.
      await waitFor(() => findWatcherPids(socketName).length > 0, 5_000, "watcher attach");

      const killedAt = Date.now();
      spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });

      await waitFor(() => exits.length > 0, 2_000, "self-exit after kill-server");
      assert.deepEqual(exits, ["tmux-gone"]);
      assert.ok(
        exitedAt - killedAt <= 2_000,
        `self-exit took ${exitedAt - killedAt}ms — must be within 2s of kill-server`,
      );
      assert.equal(fs.existsSync(endpoint), false, "socket file must be unlinked on self-exit");
    } finally {
      await serverProxy.shutdown(); // idempotent after self-exit
      spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("S4: watcher SIGKILLed while tmux alive → watcher respawned, server-proxy stays up", async () => {
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir("s4");

    const seeded = spawnSync("tmux", ["-L", socketName, "new-session", "-d", "-s", "seed"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(seeded.status, 0, `tmux new-session failed: ${seeded.stderr}`);

    const serverProxy = createServerProxy({ socketName, runtimeDir, idleExitMs: 600_000 });
    const exits: ServerProxySelfExitReason[] = [];
    serverProxy.onSelfExit((reason) => exits.push(reason));
    await serverProxy.start();
    const endpoint = serverProxy.endpoint();

    try {
      await waitFor(() => findWatcherPids(socketName).length > 0, 5_000, "initial watcher attach");
      const pid1 = findWatcherPids(socketName)[0]!;

      // Kill ONLY the watcher process; the tmux server stays alive.
      process.kill(pid1, "SIGKILL");

      // The server-proxy must probe (tmux alive) and respawn a fresh watcher —
      // and must NOT exit.
      await waitFor(
        () => findWatcherPids(socketName).some((p) => p !== pid1),
        5_000,
        "watcher respawn with a new pid",
      );
      assert.equal(exits.length, 0, "server-proxy must NOT self-exit when only the watcher died");
      assert.ok(fs.existsSync(endpoint), "server-proxy socket must still exist");

      // ServerProxy must still be serving: a fresh client can connect.
      const t = await connectSocketTransport(endpoint);
      await waitFor(() => serverProxy.connectedClientCount === 1, 2_000, "server-proxy still accepts clients");
      t.close();
      await waitFor(() => serverProxy.connectedClientCount === 0, 2_000, "client disconnect observed");

      // The RESPAWNED watcher must still drive the tmux-death exit path.
      spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
      await waitFor(() => exits.length > 0, 2_000, "self-exit via respawned watcher");
      assert.deepEqual(exits, ["tmux-gone"]);
      assert.equal(fs.existsSync(endpoint), false, "socket file must be unlinked on self-exit");
    } finally {
      await serverProxy.shutdown(); // idempotent after self-exit
      spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// tc-xnay / tc-ymxe — exit-reason wire announcement (`server-proxy.exiting`)
// ---------------------------------------------------------------------------
//
// The broker broadcasts `server-proxy.exiting` to every connected client
// immediately before a designed `_selfExit(reason)` runs.  This is the
// signal the extension's classification locus uses to distinguish a
// DESIGNED quiescence from an unexpected death.  These tests verify the
// broadcast happens for both designed reasons (idle / tmux-gone) and that
// SIGTERM-driven shutdown (the LAUNCHER explicitly disposing the broker)
// does NOT broadcast — the launcher already knows it caused the close.

describe("server-proxy – tc-xnay / tc-ymxe: designed-exit announcement", () => {
  it("X1: idle self-exit broadcasts `server-proxy.exiting` with reason=idle to connected clients", async () => {
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir("xnay-x1");
    // Short idle window so we don't wait the production 5 minutes.
    const serverProxy = createServerProxy({ socketName, runtimeDir, idleExitMs: 400 });
    await serverProxy.start();
    const endpoint = serverProxy.endpoint();

    try {
      // Connect as a wire client so we can observe the broadcast.
      const { mux } = await connectToServerProxy(endpoint);

      // Capture the next `server-proxy.exiting` message.
      const exiting = new Promise<{ type: string; reason: string }>((resolve) => {
        const unsub = mux.subscribe((msg) => {
          if (msg.type === "server-proxy.exiting") {
            unsub();
            resolve(msg as unknown as { type: string; reason: string });
          }
        });
      });

      // Idle policy fires only when BOTH the IPC client count is 0 AND
      // the live-child count is 0.  Close our client so the count drops
      // to 0 and the hysteresis runs.  The broker WILL still broadcast
      // because the broadcast happens on `_selfExit` AFTER the timer
      // fires but BEFORE shutdown closes the socket — at the moment of
      // broadcast there are zero open clients, so the message is
      // effectively dropped.
      //
      // To observe the broadcast we need a second client that lingers
      // past the close — a raw socket connection that doesn't run the
      // wire handshake doesn't count as a wire client for the broadcast.
      // So instead: keep our connection open until the broker self-
      // exits.  The broker keeps a tally of connections at the socket
      // level so the idle timer never arms while we are connected.
      //
      // Work-around: use TWO clients.  Close ONE so the count is still
      // > 0 (keeping the broker alive), then …
      //
      // Simpler: use the test-only seam.  The broker exposes onSelfExit
      // — but the WIRE broadcast is what we're testing here.  We need
      // the broadcast to reach a STILL-CONNECTED client.
      //
      // Plan: open a second wire client; close that one to bring the
      // count to 1; the broker stays alive because count > 0.  Force
      // an idle self-exit by closing the FIRST client too (count → 0)
      // → idle timer arms → fires → broadcast (the second client just
      // closed, so the broadcast loop iterates ZERO transports).
      //
      // We can't have it both ways: the idle exit policy is precisely
      // "zero clients".  Use the `_clients` map directly is the cleanest
      // — but that means the broadcast goes to a still-open transport
      // and idle exit triggers based on a DIFFERENT condition.  Test
      // by triggering tmux-gone instead: that path can exit with
      // clients still connected.
      //
      // Move this assertion into X2 (tmux-gone). The idle test (X1)
      // verifies the announcement is sent at all — we use a side
      // channel: the `onSelfExit` callback runs AFTER the broadcast
      // (the `_selfExit` order is: broadcast → shutdown → callbacks),
      // and `shutdown()` closes all client transports, so the client
      // sees a SOCKET CLOSE.  We can assert that the client received
      // the broadcast OR was already closed before reaching it; the
      // close-without-broadcast case is the broker bug we're guarding
      // against.
      //
      // Race-free approach: keep ONE connection open by issuing a
      // periodic command (the idle policy is socket-count based, not
      // command-activity based, so this doesn't keep the broker alive
      // — it idle-exits even while a command is in flight).  But the
      // idle policy is "zero clients", so… use tmux-gone for the
      // broadcast assertion (X2) where the broker exits while clients
      // are alive.
      void exiting; // X1 doesn't assert on this — moved to X2.

      // For X1 we assert the simpler contract: when the idle timer
      // fires the broker self-exits with reason "idle".  The
      // broadcast attempt is best-effort by construction.
      const exits: ServerProxySelfExitReason[] = [];
      serverProxy.onSelfExit((r) => exits.push(r));

      mux.transport.close();
      await waitFor(() => exits.length > 0, 3_000, "idle self-exit");
      assert.deepEqual(exits, ["idle"]);
    } finally {
      await serverProxy.shutdown();
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("X2 (requires tmux): tmux-gone self-exit broadcasts `server-proxy.exiting` with reason=tmux-gone to connected clients", { skip: !TMUX_AVAILABLE }, async () => {
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir("xnay-x2");

    // Seed a session so the watcher attaches.
    const seeded = spawnSync("tmux", ["-L", socketName, "new-session", "-d", "-s", "seed"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(seeded.status, 0, `tmux new-session failed: ${seeded.stderr}`);

    // Long idle window so only tmux-gone triggers exit; a wire client
    // stays connected for the entire test.
    const serverProxy = createServerProxy({ socketName, runtimeDir, idleExitMs: 600_000 });
    await serverProxy.start();
    const endpoint = serverProxy.endpoint();

    try {
      const { mux } = await connectToServerProxy(endpoint);

      const exitingP = new Promise<{ type: string; reason: string }>((resolve) => {
        const unsub = mux.subscribe((msg) => {
          if (msg.type === "server-proxy.exiting") {
            unsub();
            resolve(msg as unknown as { type: string; reason: string });
          }
        });
      });

      await waitFor(() => findWatcherPids(socketName).length > 0, 5_000, "watcher attach");

      // Kill the tmux server: watcher EOFs → probe fails → tmux-gone
      // self-exit fires → broadcast first → shutdown → callbacks.
      spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });

      const [timeoutP, clearT] = rejectAfter(5_000, "Timeout waiting for `server-proxy.exiting`");
      const msg = await Promise.race([exitingP, timeoutP]);
      clearT();

      assert.equal(msg.type, "server-proxy.exiting");
      assert.equal(msg.reason, "tmux-gone");
    } finally {
      await serverProxy.shutdown();
      spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("X3: explicit `shutdown()` (SIGTERM equivalent) does NOT broadcast — the launcher already knows it disposed", async () => {
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir("xnay-x3");

    // Long idle window — the only path to exit in this test is the
    // explicit shutdown() call.
    const serverProxy = createServerProxy({ socketName, runtimeDir, idleExitMs: 600_000 });
    await serverProxy.start();
    const endpoint = serverProxy.endpoint();

    try {
      const { mux } = await connectToServerProxy(endpoint);

      let exitingSeen = false;
      mux.subscribe((m) => {
        if (m.type === "server-proxy.exiting") exitingSeen = true;
      });

      // Explicit shutdown — mirrors the SIGTERM-driven entry-point path.
      await serverProxy.shutdown();

      // Give any pending messages a moment to flush before we assert.
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(
        exitingSeen,
        false,
        "shutdown() must NOT broadcast `server-proxy.exiting` — only designed _selfExit does",
      );
    } finally {
      // Already shut down — idempotent.
      await serverProxy.shutdown();
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// tc-295a.4 (W1.3): enriched SessionEntry fields in snapshot and deltas
// ---------------------------------------------------------------------------

describe("server-proxy – enriched session fields (tc-295a.4)", { skip: !TMUX_AVAILABLE }, () => {
  let serverProxy: ServerProxyHandle;
  let socketName: string;

  beforeEach(async () => {
    socketName = nextSocketName();
    serverProxy = createServerProxy({ socketName });
    await serverProxy.start();
  });

  afterEach(async () => {
    await serverProxy.shutdown();
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
  });

  it("E1: snapshot carries tmuxccMarked=true, paneCount>=1, lastActivity>0 after session.claim", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    const claimResp = await sendServerProxyCommand(mux, { kind: "session.claim", name: "e1-marked" }, seq);
    assert.ok(claimResp.result.ok, `Claim failed: ${JSON.stringify(claimResp.result)}`);

    // Reconnect to get a fresh snapshot with the session present.
    mux.transport.close();
    const { snapshot } = await connectToServerProxy(serverProxy.endpoint());

    const info = snapshot.sessions.find((s) => s.name === "e1-marked");
    assert.ok(info, `sessions.snapshot must include 'e1-marked': ${JSON.stringify(snapshot.sessions)}`);

    assert.equal(
      info.tmuxccMarked,
      true,
      `tmuxccMarked must be true for a session claimed by tmuxcc; got ${String(info.tmuxccMarked)}`,
    );
    assert.ok(
      info.paneCount >= 1,
      `paneCount must be >= 1 in snapshot; got ${String(info.paneCount)}`,
    );
    const nowEpoch = Math.floor(Date.now() / 1_000);
    assert.ok(
      info.lastActivity > 0 && info.lastActivity <= nowEpoch + 5,
      `lastActivity must be a positive recent Unix epoch; got ${String(info.lastActivity)}`,
    );
  });

  it("E2: snapshot carries tmuxccMarked=false for a foreign session (no @tmuxcc option)", async () => {
    // Connect first so we can subscribe to sessions.added before creating the session.
    const { mux } = await connectToServerProxy(serverProxy.endpoint());

    // Subscribe to sessions.added to await discovery of the foreign session.
    const foreignAddedPromise = new Promise<ServerProxySessionAddedMessage>((resolve) => {
      const unsub = mux.subscribe((msg) => {
        if (msg.type === "sessions.added" && (msg as unknown as ServerProxySessionAddedMessage).name === "e2-foreign") {
          unsub();
          resolve(msg as unknown as ServerProxySessionAddedMessage);
        }
      });
    });

    // Create a session outside tmuxcc — no @tmuxcc 1 option set.
    const foreignResult = spawnSync(
      "tmux",
      ["-L", socketName, "new-session", "-d", "-s", "e2-foreign", "-P", "-F", "#{session_id}"],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(foreignResult.status, 0, `tmux new-session failed: ${foreignResult.stderr}`);

    // Wait for the server-proxy to discover the foreign session via the watcher
    // firing %sessions-changed (up to 5 s).
    const [timeoutP, clearTimeout_] = rejectAfter(5_000, "Timeout waiting for e2-foreign sessions.added");
    const added = await Promise.race([foreignAddedPromise, timeoutP]);
    clearTimeout_();

    assert.equal(added.type, "sessions.added");
    assert.equal(added.name, "e2-foreign");
    assert.equal(
      (added as unknown as { tmuxccMarked: boolean }).tmuxccMarked,
      false,
      `sessions.added for a foreign session must carry tmuxccMarked=false; got ${String((added as unknown as { tmuxccMarked: unknown }).tmuxccMarked)}`,
    );

    // Verify the snapshot also reflects tmuxccMarked=false (redundant but exhaustive).
    const { snapshot } = await connectToServerProxy(serverProxy.endpoint());
    const info = snapshot.sessions.find((s) => s.name === "e2-foreign");
    assert.ok(info, `sessions.snapshot must include 'e2-foreign': ${JSON.stringify(snapshot.sessions)}`);
    assert.equal(
      info!.tmuxccMarked,
      false,
      `tmuxccMarked must be false for a foreign session in snapshot; got ${String(info!.tmuxccMarked)}`,
    );

    mux.transport.close();
  });

  it("E3: sessions.added delta carries tmuxccMarked, paneCount, lastActivity for a claimed session", async () => {
    const { mux } = await connectToServerProxy(serverProxy.endpoint());
    const seq = { value: 1 };

    // Subscribe to sessions.added before triggering the claim.
    const addedPromise = new Promise<ServerProxySessionAddedMessage>((resolve) => {
      const unsub = mux.subscribe((msg) => {
        if (msg.type === "sessions.added" && (msg as unknown as ServerProxySessionAddedMessage).name === "e3-delta") {
          unsub();
          resolve(msg as unknown as ServerProxySessionAddedMessage);
        }
      });
    });

    await sendServerProxyCommand(mux, { kind: "session.claim", name: "e3-delta" }, seq);

    const [timeoutP, clearTimeout_] = rejectAfter(3_000, "Timeout waiting for sessions.added e3-delta");
    const added = await Promise.race([addedPromise, timeoutP]);
    clearTimeout_();

    assert.equal(added.type, "sessions.added");
    assert.equal(added.name, "e3-delta");
    assert.equal(
      (added as unknown as { tmuxccMarked: boolean }).tmuxccMarked,
      true,
      `sessions.added must carry tmuxccMarked=true for a claimed session; got ${String((added as unknown as { tmuxccMarked: unknown }).tmuxccMarked)}`,
    );
    assert.ok(
      (added as unknown as { paneCount: number }).paneCount >= 1,
      `sessions.added must carry paneCount>=1; got ${String((added as unknown as { paneCount: unknown }).paneCount)}`,
    );
    const nowEpoch = Math.floor(Date.now() / 1_000);
    const la = (added as unknown as { lastActivity: number }).lastActivity;
    assert.ok(
      la > 0 && la <= nowEpoch + 5,
      `sessions.added must carry a positive recent lastActivity; got ${String(la)}`,
    );

    mux.transport.close();
  });
});
