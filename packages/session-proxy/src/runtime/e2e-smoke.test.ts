/**
 * tc-2ph — Full-stack e2e smoke test
 *
 * Drives REAL tmux 3.4 through the whole stack:
 *   tmux -CC (via PTY bridge) → createSessionProxy → transport pair → client modules
 *   (Mirror + PaneStreamConsumer + Mirror.attach) → EchoRenderHook callbacks
 *
 * Acceptance scenarios (run against real tmux):
 *   E1. Connect: onWindowAdded + onPaneOpened + onConnected + onFocusChanged fire.
 *   E2. Input/output round-trip: sendInput → output arrives in onPaneOutput.
 *   E3. Multi-pane: sendCommand(split-pane) → 2nd onPaneOpened fires; 2nd
 *       pane output arrives on the 2nd pane (NOT mixed into pane 1).
 *   E4. Resize: resizePane → onPaneResized fires.
 *   E5. Teardown: tmux server absent after teardown().
 *
 * # Handshake sequencing — why we use the low-level approach
 *
 * The high-level `createClient(transport, hook).connect()` runs
 * `runClientHandshake` which must overlap with the session-proxy's
 * `runSessionProxyHandshake` (both run concurrently in Promise.all).  The
 * `setImmediate` deferral of `sessionProxy.addClient()` causes the server-side
 * handshake to race with the already-completed client-side handshake.
 *
 * Solution: mirror the proven pattern from integration.test.ts (Suite 3 R1/R2)
 * and session-proxy-transport.test.ts — run both handshakes concurrently, then
 * wire up the client modules (Mirror, PaneStreamConsumer) manually AFTER the
 * handshake resolves, then call mirror.wireDataSources(byteSource) +
 * mirror.attach(hook).  This gives us EchoRenderHook callbacks without the
 * timing race.
 *
 * # tc-cox.5 migration note
 *
 * This harness previously used createRenderHookDriver (render-hook.ts) which
 * has been deleted per the pre-alpha-redesign rule.  The wiring now uses
 * Mirror.wireDataSources() + Mirror.attach(), which is the same path used by
 * the production connectClient() in client.ts.  The E2ESession.teardown()
 * calls mirror.detachHook() instead of renderSession.stop().
 *
 * # "VS Code terminals" layer
 *
 * The VS Code layer (tmuxcc-vscode) is a thin renderer on top of the client's
 * RenderHook.  For THIS smoke the "VS Code terminals" layer is represented by
 * EchoRenderHook callbacks — asserting those fire correctly IS asserting the
 * VS Code layer would render correctly.
 *
 * # Import strategy
 *
 * This file imports from @tmuxcc/client by relative src paths (outside
 * rootDir) so that tsx resolves them correctly at runtime.  It is excluded
 * from the session-proxy's tsconfig build to avoid rootDir violations — matching the
 * pattern used by tmuxcc-vscode/tsconfig.json for session-proxy-transport.test.ts.
 *
 * @module runtime/e2e-smoke.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// tc-blk — process-level safety net: register every spawned tmux socket so a
// thrown / timed-out test still has its server killed.
// flushAllTracked is imported for the E6 regression test that simulates a
// thrown test body and verifies the safety net reaps the orphan.
import { trackSocket, killTmuxServer, flushAllTracked } from "./test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// SessionProxy internals (within session-proxy/src, no rootDir issue)
// ---------------------------------------------------------------------------

import { createSessionProxy } from "./session-proxy.js";
import type { SessionProxy } from "./session-proxy.js";
import { createInMemoryTransportPair } from "../wire/transport.js";
import type { PaneId } from "../wire/ids.js";
import {
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
} from "../wire/index.js";
import type { ClientMessage } from "../wire/index.js";

// ---------------------------------------------------------------------------
// Client sub-modules — relative src paths; tsx resolves at runtime.
// Excluded from session-proxy tsconfig (see tsconfig.json "exclude").
// ---------------------------------------------------------------------------

// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { Mirror } from "@tmuxcc/client/src/mirror.js";
// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { PaneStreamConsumer } from "@tmuxcc/client/src/pane-stream.js";
// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { createInputApi } from "@tmuxcc/client/src/input.js";
// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { EchoRenderHook } from "@tmuxcc/client/src/render-hook.js";
// @ts-ignore — outside rootDir; resolved by tsx at runtime
import type { RenderHookCall, PaneInfo, ClientController } from "@tmuxcc/client/src/render-hook.js";

// ---------------------------------------------------------------------------
// Guard: only register the E1-E6 describe block when this file is the direct
// test entry point.  Other test files (resize-roundtrip.test.ts,
// resilience.test.ts, flow-load.test.ts) import setupE2E from this file.
// Without this guard the Node.js test runner re-registers the full E1-E6 suite
// in each importer's subprocess, causing 4× concurrent real-tmux load that
// produces intermittent "snapshot may be empty" failures under system pressure.
// ---------------------------------------------------------------------------

const isMain = fileURLToPath(import.meta.url) === (process.argv[1] ?? "");

// ---------------------------------------------------------------------------
// Guard: skip entire suite if tmux absent
// ---------------------------------------------------------------------------

const tmuxAvailable = (() => {
  try {
    const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
    return r.status === 0 && /tmux\s+\d/.test(r.stdout ?? "");
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Capabilities — same as integration.test.ts and session-proxy-transport.test.ts
// ---------------------------------------------------------------------------

const CLIENT_CAPS = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: [
    "pane-lifecycle" as const,
    "layout-updates" as const,
    "focus-events" as const,
    "input-forwarding" as const,
  ],
};

// ---------------------------------------------------------------------------
// Socket-name factory — unique per run + per label
// ---------------------------------------------------------------------------

const RUN_SUFFIX = `${Date.now()}`;

function sockName(label: string): string {
  // tc-bpn — shape: tmuxcc-test-<pid>-<suffix> required by test-tmux-cleanup.
  return `tmuxcc-test-${process.pid}-e2e-${RUN_SUFFIX}-${label}`;
}

// ---------------------------------------------------------------------------
// killServer — idempotent kill of a tmux server by socket name.
// Delegates to the shared cleanup helper (which also forgets the socket).
// ---------------------------------------------------------------------------

function killServer(sock: string): void {
  killTmuxServer(sock);
}

// ---------------------------------------------------------------------------
// waitFor — poll predicate until truthy or timeout
// ---------------------------------------------------------------------------

function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  msg: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() > deadline) {
        return reject(new Error(`waitFor timeout (${timeoutMs}ms): ${msg}`));
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// waitForOutput — poll EchoRenderHook until pane has needle in output
// ---------------------------------------------------------------------------

function waitForOutput(
  hook: InstanceType<typeof EchoRenderHook>,
  paneId: PaneId,
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const needleBytes = Buffer.from(needle, "utf8");
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const all = accumulatedOutput(hook, paneId);
      if (all.includes(needleBytes)) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error(
          `waitForOutput timeout (${timeoutMs}ms): pane ${paneId as string} ` +
          `lacks "${needle}" in ${all.length} bytes: ${all.slice(0, 200).toString("utf8")}`,
        ));
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// accumulatedOutput — concatenate all onPaneOutput bytes for a pane
// ---------------------------------------------------------------------------

function accumulatedOutput(
  hook: InstanceType<typeof EchoRenderHook>,
  paneId: PaneId,
): Buffer {
  const calls: RenderHookCall[] = hook.calls as RenderHookCall[];
  return Buffer.concat(
    calls
      .filter((c: RenderHookCall) => c.type === "paneOutput" && c.paneId === paneId)
      .map((c: RenderHookCall) => {
        if (c.type !== "paneOutput") return Buffer.alloc(0);
        return Buffer.from(c.bytes);
      }),
  );
}

// ===========================================================================
// setupE2E — REUSABLE HARNESS
//
// Exported for dependent beads:
//   tc-4sg  — perf pass
//   tc-55t  — flow-control under load
//   tc-e3m  — reconnect/restart resilience
//   tc-i7e  — resize correctness round-trip
//
// API:
// ```ts
// import { setupE2E } from "./e2e-smoke.test.js";
//
// const session = await setupE2E("my-label");
// try {
//   const { hook, paneId, controller, sessionProxy } = session;
//   controller.sendInput(paneId, "echo hello\n");
//   await session.waitForOutput(paneId, "hello", 8000);
// } finally {
//   await session.teardown();
// }
// ```
//
// Fields returned:
//   session-proxy     — SessionProxy handle (host, demux, pipeline, server, inputPath,
//                flowController).  Low-level access for advanced tests.
//   controller — ClientController with sendInput / resizePane / sendCommand.
//   hook       — EchoRenderHook recording all render-hook callbacks.
//   paneId     — Wire PaneId of the first pane from the snapshot (e.g. "p1").
//   socketName — tmux -L socket name (for direct tmux commands if needed).
//   sessionProxyTransport / clientTransport — the raw transport pair.
//   waitForOutput(paneId, needle, ms) — poll hook until pane output has needle.
//   teardown() — stop render driver, kill sessionProxy, kill tmux server. Idempotent.
// ===========================================================================

export interface E2ESession {
  /** The fully assembled session-proxy runtime. */
  readonly sessionProxy: SessionProxy;
  /** Client controller: sendInput / resizePane / sendCommand. */
  readonly controller: ClientController;
  /** EchoRenderHook recording all render-hook callbacks. */
  readonly hook: InstanceType<typeof EchoRenderHook>;
  /** Wire PaneId of the first pane from the initial snapshot. */
  readonly paneId: PaneId;
  /** tmux -L socket name. */
  readonly socketName: string;
  /** The session-proxy-side transport endpoint. */
  readonly sessionProxyTransport: ReturnType<typeof createInMemoryTransportPair>["session-proxy"];
  /** The client-side transport endpoint. */
  readonly clientTransport: ReturnType<typeof createInMemoryTransportPair>["client"];
  /** Poll until pane output contains needle. Throws on timeout. */
  waitForOutput(paneId: PaneId, needle: string, timeoutMs: number): Promise<void>;
  /** Graceful teardown: detach mirror hook → kill session-proxy → kill tmux server. */
  teardown(): Promise<void>;
}

/**
 * Stand up the full tmuxcc stack against a real tmux -CC session.
 *
 * Uses the proven low-level wiring pattern from integration.test.ts (Suite 3
 * R1/R2) and session-proxy-transport.test.ts: both handshakes run concurrently in
 * Promise.all, then client modules are wired up afterward.
 *
 * @param label - Short label for the socket name (keep it test-unique).
 * @param opts  - Optional session-proxy host overrides (cols, rows, sessionName).
 */
export async function setupE2E(
  label: string,
  opts: { cols?: number; rows?: number; sessionName?: string } = {},
): Promise<E2ESession> {
  const sock = sockName(label);
  // tc-blk — register BEFORE we spawn so a throw between here and teardown
  // still has its socket reaped by the process-exit / top-level after() net.
  trackSocket(sock);
  const sessionName = opts.sessionName ?? `e2e-${label}`;

  // 1. Create and start the sessionProxy (spawns real tmux -CC via PTY bridge).
  const sessionProxy = createSessionProxy({
    host: {
      socketName: sock,
      sessionName,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    },
  });
  sessionProxy.host.onError(() => { /**/ });
  await sessionProxy.start();

  // 2. Create in-memory transport pair.
  const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();

  // 3. Attach data-plane demux BEFORE handshake so byte frames are received.
  const detach = sessionProxy.demux.attachTransport(sessionProxyTransport);

  // 4. Build client-side modules upfront — they don't require the snapshot yet.
  const mirror = new Mirror();
  const paneConsumer = new PaneStreamConsumer();

  // 5. Start the server-side handshake concurrently with the client handshake.
  //    We do NOT await addClient yet — we must wire clientTransport.onControl
  //    BEFORE addClient's snapshot arrives.
  //
  //    Timing contract (mirrors SessionProxyConnection.connect()):
  //      addClient:           await runSessionProxyHandshake → ... → await Promise.resolve()
  //                           → sendSnapshot  (microtask N+1)
  //      runClientHandshake:  receives session-proxy.capabilities → sends client.capabilities
  //                           → resolves (microtask N)
  //      THIS CODE:           await runClientHandshake resolves (microtask N)
  //                           → install clientTransport.onControl synchronously (no await)
  //                           → addClient's snapshot arrives into our handler (microtask N+1) ✓
  //
  //    The microtask gap (await Promise.resolve() in serve.ts addClient) is the
  //    seam that lets us install the handler between handshake-settle and snapshot-send.
  const addPromise = sessionProxy.server.addClient(sessionProxyTransport);
  await runClientHandshake(clientTransport, CLIENT_CAPS);

  // 6. Wire clientTransport.onControl → mirror SYNCHRONOUSLY here, before the
  //    next microtask (which is when addClient sends the real wire snapshot).
  //    This is the same pattern used by SessionProxyConnection.#installPostHandshakeRouting().
  //    Any subsequent wire message (snapshot, deltas, client-count.changed, etc.)
  //    is routed through here — no manual snapshot construction needed.
  clientTransport.onControl((msg: ClientMessage) => {
    const dm = msg as { type: string };
    if (dm.type === "snapshot") {
      mirror.receiveSnapshot(msg as Parameters<typeof mirror.receiveSnapshot>[0]);
    } else {
      // Deltas, command responses, client-count.changed, errors, etc.
      try { mirror.receiveDelta(msg as Parameters<typeof mirror.receiveDelta>[0]); } catch { /**/ }
    }
  });

  // Wire data frames from clientTransport → paneConsumer (also before addClient
  // returns, in case any pane output arrives during the startup sequence).
  clientTransport.onData((paneId: PaneId, bytes: Uint8Array) => {
    paneConsumer.push(paneId, bytes);
  });

  // Now await addClient to complete — the snapshot (and any subsequent startup
  // wire messages) will have flowed through clientTransport.onControl above.
  await addPromise;

  // 7. Wire the input path (sessionProxy.server.addClient() sets up resync handling
  //    on sessionProxyTransport.onControl; we overwrite it here with our inputPath
  //    handler since these tests do not exercise resync).
  sessionProxyTransport.onControl((msg) => {
    sessionProxy.inputPath.handleClientMessage(msg as ClientMessage);
  });

  // 8. InputApi — for sendInput / resizePane / sendCommand.
  //    createInputApi expects a SessionProxyConnection with a send() method.
  //    We provide a minimal shim that forwards to clientTransport.sendControl.
  const connShim = {
    send(msg: ClientMessage): void {
      clientTransport.sendControl(msg);
    },
  };
  const inputApi = createInputApi(connShim, {});

  // 9. Wire byte source into mirror + attach the EchoRenderHook.
  //
  //    tc-cox.5: replaced createRenderHookDriver with Mirror.wireDataSources() +
  //    Mirror.attach() — the same path used by connectClient() in client.ts.
  //    PaneStreamConsumer is structurally compatible with ByteSource; we adapt
  //    it inline (same pattern as consumerToByteSource in client.ts).
  const hook: InstanceType<typeof EchoRenderHook> = new EchoRenderHook();
  mirror.wireDataSources({
    onPaneOutput(paneId: PaneId, callback: (bytes: Uint8Array) => void): () => void {
      return paneConsumer.onPaneOutput(paneId, callback);
    },
  });
  mirror.attach(hook);

  // Build a ClientController that delegates to the InputApi.
  const controller: ClientController = {
    sendInput(paneId: PaneId, data: string): void { inputApi.sendInput(paneId, data); },
    resizePane(paneId: PaneId, cols: number, rows: number): void { inputApi.resizePane(paneId, cols, rows); },
    sendCommand(cmd: import("../wire/index.js").WireCommand): void { inputApi.sendCommand(cmd); },
  };

  // 10. Validate: we must have at least 1 pane from the snapshot.
  const calls: RenderHookCall[] = hook.calls as RenderHookCall[];
  const firstPaneOpened = calls.find((c: RenderHookCall) => c.type === "paneOpened");
  if (firstPaneOpened === undefined || firstPaneOpened.type !== "paneOpened") {
    mirror.detachHook();
    detach();
    sessionProxy.kill();
    killServer(sock);
    throw new Error("setupE2E: no onPaneOpened after mirror.attach() — snapshot may be empty");
  }
  const firstPaneId: PaneId = (firstPaneOpened as { type: "paneOpened"; pane: PaneInfo }).pane.paneId as PaneId;

  // ── Teardown ────────────────────────────────────────────────────────────────

  let tornDown = false;
  async function teardown(): Promise<void> {
    if (tornDown) return;
    tornDown = true;
    try { mirror.detachHook(); } catch { /**/ }
    try { detach(); } catch { /**/ }
    try { sessionProxy.kill(); } catch { /**/ }
    await new Promise<void>((r) => {
      if (sessionProxy.host.exited) { r(); return; }
      sessionProxy.host.onExit(() => r());
      setTimeout(r, 1500);
    });
    killServer(sock);
  }

  function sessionWaitForOutput(pid: PaneId, needle: string, timeoutMs: number): Promise<void> {
    return waitForOutput(hook, pid, needle, timeoutMs);
  }

  return {
    sessionProxy,
    controller,
    hook,
    paneId: firstPaneId,
    socketName: sock,
    sessionProxyTransport,
    clientTransport,
    waitForOutput: sessionWaitForOutput,
    teardown,
  };
}

// ===========================================================================
// E7 Full-stack smoke suite
//
// Only registered when this file is the direct test entry point (isMain).
// Importing files (resize-roundtrip.test.ts, resilience.test.ts,
// flow-load.test.ts) use setupE2E() without re-running the full suite.
// ===========================================================================

if (isMain) describe(
  "tc-2ph: Full e2e smoke — real tmux → session-proxy → client → render hooks",
  { skip: !tmuxAvailable ? "tmux not found on PATH" : false },
  () => {
    // -----------------------------------------------------------------------
    // E1. Connect — render-hook callbacks fire from real tmux snapshot
    // -----------------------------------------------------------------------

    it(
      "E1: connect fires onWindowAdded + onPaneOpened + onFocusChanged + onConnected",
      { timeout: 20_000 },
      async () => {
        const session = await setupE2E("connect");
        after(() => killServer(session.socketName));
        try {
          const calls: RenderHookCall[] = session.hook.calls as RenderHookCall[];

          assert.ok(
            calls.some((c: RenderHookCall) => c.type === "windowAdded"),
            "onWindowAdded must fire on connect",
          );

          const paneOpened = calls.find((c: RenderHookCall) => c.type === "paneOpened");
          assert.ok(paneOpened !== undefined, "onPaneOpened must fire on connect");
          if (paneOpened?.type === "paneOpened") {
            assert.ok(typeof paneOpened.pane.paneId === "string", "paneId must be a string");
            assert.ok(paneOpened.pane.cols > 0, "initial pane must have positive cols");
            assert.ok(paneOpened.pane.rows > 0, "initial pane must have positive rows");
          }

          assert.ok(
            calls.some((c: RenderHookCall) => c.type === "focusChanged"),
            "onFocusChanged must fire on connect",
          );

          assert.ok(
            calls.some((c: RenderHookCall) => c.type === "connected"),
            "onConnected must fire after snapshot replay",
          );
        } finally {
          await session.teardown();
        }
      },
    );

    // -----------------------------------------------------------------------
    // E2. Input/output round-trip
    // -----------------------------------------------------------------------

    it(
      "E2: sendInput → pane output contains echoed bytes (byte-exact substring)",
      { timeout: 20_000 },
      async () => {
        const session = await setupE2E("output");
        after(() => killServer(session.socketName));
        try {
          const { controller, paneId } = session;

          controller.sendInput(paneId, "echo hello-e2e\n");

          await session.waitForOutput(paneId, "hello-e2e", 12_000);

          const allBytes = accumulatedOutput(session.hook, paneId);
          assert.ok(
            allBytes.includes(Buffer.from("hello-e2e")),
            `"hello-e2e" must appear in pane output; got ${allBytes.length} bytes`,
          );
        } finally {
          await session.teardown();
        }
      },
    );

    // -----------------------------------------------------------------------
    // E3. Multi-pane — split-pane → 2nd onPaneOpened; independent output
    // -----------------------------------------------------------------------

    it(
      "E3: sendCommand(split-pane) → 2nd onPaneOpened + separate output per pane",
      { timeout: 30_000 },
      async () => {
        const session = await setupE2E("split");
        after(() => killServer(session.socketName));
        try {
          const { hook, controller, paneId: pane1Id } = session;
          const calls: RenderHookCall[] = hook.calls as RenderHookCall[];

          assert.equal(
            calls.filter((c: RenderHookCall) => c.type === "paneOpened").length,
            1,
            "must start with exactly 1 pane opened",
          );

          // Split pane 1 vertically.
          controller.sendCommand({
            kind: "split-pane",
            paneId: pane1Id,
            direction: "vertical",
          });

          // Wait for 2nd onPaneOpened.
          const pane2Info = await waitFor(
            () => {
              const opened = calls.filter((c: RenderHookCall) => c.type === "paneOpened");
              if (opened.length >= 2) {
                const second = opened[1];
                if (second?.type === "paneOpened") return second.pane as PaneInfo;
              }
              return undefined;
            },
            12_000,
            "2nd onPaneOpened did not fire after split-pane command",
          );

          const pane2Id: PaneId = pane2Info.paneId as PaneId;
          assert.notEqual(pane2Id, pane1Id, "2nd pane must have a different paneId");

          // Send distinct commands to each pane.
          controller.sendInput(pane1Id, "echo pane1-marker\n");
          controller.sendInput(pane2Id, "echo pane2-marker\n");

          await session.waitForOutput(pane1Id, "pane1-marker", 12_000);
          await session.waitForOutput(pane2Id, "pane2-marker", 12_000);

          // Assert no cross-contamination.
          const pane1Bytes = accumulatedOutput(hook, pane1Id);
          assert.ok(
            !pane1Bytes.includes(Buffer.from("pane2-marker")),
            `pane2-marker must not appear in pane1 stream (${pane1Bytes.toString("utf8").slice(0, 200)})`,
          );

          const pane2Bytes = accumulatedOutput(hook, pane2Id);
          assert.ok(
            !pane2Bytes.includes(Buffer.from("pane1-marker")),
            `pane1-marker must not appear in pane2 stream (${pane2Bytes.toString("utf8").slice(0, 200)})`,
          );
        } finally {
          await session.teardown();
        }
      },
    );

    // -----------------------------------------------------------------------
    // tc-fx4. New window — open-window → onPaneOpened for the NEW window's pane
    //
    // tmux 3.4 emits %window-add WITHOUT a following %layout-change for a
    // freshly created window, so the window's pane(s) are invisible to the
    // model unless the pipeline queries the layout explicitly
    // (RuntimePipelineImpl._reconcileNewWindowLayout).  This is the session-proxy
    // half of the tc-fx4 "user ran tmuxcc.newWindow and saw nothing" bug:
    // without the reconcile, no pane.opened delta reaches the client and no
    // VS Code terminal tab is ever created.
    // -----------------------------------------------------------------------

    it(
      "tc-fx4: sendCommand(open-window) → onWindowAdded AND onPaneOpened for the new window's pane",
      { timeout: 30_000 },
      async () => {
        const session = await setupE2E("openwin");
        after(() => killServer(session.socketName));
        try {
          const { hook, controller, paneId: pane1Id } = session;
          const calls: RenderHookCall[] = hook.calls as RenderHookCall[];

          assert.equal(
            calls.filter((c: RenderHookCall) => c.type === "paneOpened").length,
            1,
            "must start with exactly 1 pane opened",
          );
          const initialWindowIds = new Set(
            calls
              .filter((c: RenderHookCall) => c.type === "windowAdded")
              .map((c) => (c as { type: "windowAdded"; window: { windowId: string } }).window.windowId),
          );

          // Open a new window (the tmuxcc.newWindow wire command).
          controller.sendCommand({ kind: "open-window" });

          // The new window must surface...
          const newWindow = await waitFor(
            () => {
              const added = calls.filter((c: RenderHookCall) => c.type === "windowAdded");
              for (const c of added) {
                const w = (c as { type: "windowAdded"; window: { windowId: string } }).window;
                if (!initialWindowIds.has(w.windowId)) return w;
              }
              return undefined;
            },
            12_000,
            "onWindowAdded did not fire for the new window after open-window",
          );

          // ...AND its first pane must surface as pane.opened — this is the
          // assertion that fails without the %window-add layout reconcile.
          const pane2Info = await waitFor(
            () => {
              const opened = calls.filter((c: RenderHookCall) => c.type === "paneOpened");
              for (const c of opened) {
                const p = (c as { type: "paneOpened"; pane: PaneInfo }).pane;
                if (p.paneId !== pane1Id && p.windowId === newWindow.windowId) {
                  return p as PaneInfo;
                }
              }
              return undefined;
            },
            12_000,
            "onPaneOpened did not fire for the new window's pane after open-window " +
              "(tc-fx4: %window-add layout reconcile missing?)",
          );

          // The new pane must be usable: round-trip output through it.
          const pane2Id: PaneId = pane2Info.paneId as PaneId;
          controller.sendInput(pane2Id, "echo newwin-marker\n");
          await session.waitForOutput(pane2Id, "newwin-marker", 12_000);
        } finally {
          await session.teardown();
        }
      },
    );

    // -----------------------------------------------------------------------
    // E4. Resize — resizePane round-trip; session-proxy stays alive after resize
    //
    // resizePane() sends resize.request → session-proxy issues refresh-client -C WxH
    // → tmux applies → may or may not emit pane.resized delta (tmux 3.4 only
    // emits %layout-change when the layout actually changes; in a single-pane
    // session the pane may already fill the window so no layout event fires).
    // We assert two things:
    //   1. The resize is processed without error (no throw/crash).
    //   2. The session-proxy is still alive: a subsequent echo still produces output.
    // If onPaneResized does arrive within the window, we also validate it.
    // -----------------------------------------------------------------------

    it(
      "E4: resizePane(100, 30) — processed without error; session-proxy stays live post-resize",
      { timeout: 20_000 },
      async () => {
        const session = await setupE2E("resize");
        after(() => killServer(session.socketName));
        try {
          const { hook, controller, paneId } = session;
          const calls: RenderHookCall[] = hook.calls as RenderHookCall[];

          // Issue resize — must not throw.
          controller.resizePane(paneId, 100, 30);

          // Allow tmux to process the resize (brief wait — no busy-spin).
          await new Promise<void>((r) => setTimeout(r, 500));

          // Validate onPaneResized if it fired (optional — tmux may not emit
          // %layout-change for a single-pane resize; see test header).
          const resized = calls.find(
            (c: RenderHookCall) => c.type === "paneResized" && c.paneId === paneId,
          );
          if (resized !== undefined && resized.type === "paneResized") {
            assert.ok(resized.cols > 0 && resized.rows > 0, "paneResized dims must be positive");
          }

          // Assert session-proxy is still live: a subsequent echo must produce output.
          controller.sendInput(paneId, "echo post-resize-alive\n");
          await session.waitForOutput(paneId, "post-resize-alive", 10_000);
        } finally {
          await session.teardown();
        }
      },
    );

    // -----------------------------------------------------------------------
    // E5. Teardown — tmux server absent after teardown()
    // -----------------------------------------------------------------------

    it(
      "E5: teardown() kills session-proxy + tmux server cleanly",
      { timeout: 15_000 },
      async () => {
        const sock = sockName("cleanup");
        after(() => killServer(sock)); // belt-and-suspenders

        const session = await setupE2E("cleanup");
        await session.teardown();

        const check = spawnSync("tmux", ["-L", sock, "list-sessions"], { timeout: 3000 });
        assert.ok(check.status !== 0, "tmux server must not be running after teardown()");
      },
    );

    // -----------------------------------------------------------------------
    // E6 — tc-blk regression: throw mid-body leaves no orphan tmux server.
    //
    // Stands up setupE2E (which spawns a real tmux -CC server), then
    // SIMULATES a thrown test body by not calling session.teardown() and
    // not directly killing the server. We then invoke the same code path
    // the process-exit / top-level after() hook will run — flushAllTracked
    // — and assert tmux is gone.
    //
    // This is the acceptance criterion from the bead: "a test that throws
    // mid-body still leaves no orphaned server".
    //
    // We can't actually let the test throw (it would fail the suite). The
    // observable property is: the cleanup happens via the registered safety
    // net, NOT via any per-test teardown. flushAllTracked is exactly what
    // the process-exit/SIGINT handlers and the top-level after() invoke.
    // -----------------------------------------------------------------------

    it(
      "E6 (tc-blk): tmux server spawned by setupE2E is reaped by safety net even when per-test teardown is skipped",
      { timeout: 20_000 },
      async () => {
        const session = await setupE2E("throw-regression");

        // SIMULATE a thrown test body: do NOT call session.teardown(),
        // do NOT call killServer(session.socketName). The only cleanup
        // path is the shared safety net.

        // Sanity: the server must be alive before we trigger cleanup
        // (otherwise the test is vacuous).
        const aliveCheck = spawnSync(
          "tmux", ["-L", session.socketName, "list-sessions"], { timeout: 3000 },
        );
        assert.equal(
          aliveCheck.status, 0,
          "E6: tmux server must be alive immediately after setupE2E (sanity)",
        );

        // Now invoke the safety net's flush — same code that runs from
        // process.on('exit') and the top-level after() hook.
        flushAllTracked();

        // After flush, the server must be gone — this is the bead's
        // "throws mid-body still leaves no orphaned server" criterion.
        const deadCheck = spawnSync(
          "tmux", ["-L", session.socketName, "list-sessions"], { timeout: 3000 },
        );
        assert.notEqual(
          deadCheck.status, 0,
          `E6 (tc-blk): tmux server on ${session.socketName} must be reaped by the safety net`,
        );

        // Also tear down the session-proxy's bridge process so we don't leave a
        // stranded host child (it will exit on its own when tmux dies, but
        // we wait briefly to be a polite test citizen).
        session.sessionProxy.kill();
      },
    );
  },
);

// ===========================================================================
// E7 Synchronize-panes regression suite (tc-7xv.12)
//
// Codifies the "VERIFIED" claim from HANDOFF §4.5:
//   "setw synchronize-panes on intercepts the send-keys path, so tmux
//    broadcasts to every pane in the window natively. No extension-side
//    fan-out needed."
//
// Tests:
//   SP1. After setSynchronizePanes(windowId, true) the model reflects on=true
//        (window.sync.changed delta reaches the mirror).
//   SP2. REGRESSION: sync ON + send-keys via server-proxy to one pane → ALL panes
//        receive the input (native tmux broadcast, §4.5 VERIFIED).
//   SP3. After setSynchronizePanes(windowId, false) the model reflects on=false.
// ===========================================================================

describe(
  "tc-7xv.12: synchronize-panes — server-proxy wiring + broadcast regression",
  { skip: !tmuxAvailable ? "tmux not found on PATH" : false },
  () => {
    // -----------------------------------------------------------------------
    // SP1 + SP2 + SP3: single test that covers all three acceptance criteria.
    //
    // Design: use setupE2E to get a real sessionProxy (pane1), then split to get
    // pane2, then enable sync and verify input to pane1 appears in pane2 too.
    // -----------------------------------------------------------------------

    it(
      "SP2 (REGRESSION): sync ON → send-keys to one pane broadcasts to all panes in window",
      { timeout: 40_000 },
      async () => {
        const session = await setupE2E("sync-panes");
        after(() => killServer(session.socketName));
        try {
          const { hook, controller, paneId: pane1Id } = session;
          const calls: RenderHookCall[] = hook.calls as RenderHookCall[];

          // Step 1: split to get a second pane.
          controller.sendCommand({ kind: "split-pane", paneId: pane1Id, direction: "vertical" });

          const pane2Info = await waitFor(
            () => {
              const opened = calls.filter((c: RenderHookCall) => c.type === "paneOpened");
              if (opened.length >= 2) {
                const second = opened[1];
                if (second?.type === "paneOpened") return second.pane as PaneInfo;
              }
              return undefined;
            },
            12_000,
            "second pane did not open",
          );
          const pane2Id: PaneId = pane2Info.paneId as PaneId;

          // Step 2: verify panes are independent before sync.
          controller.sendInput(pane1Id, "echo pre-sync-pane1\n");
          await waitForOutput(hook, pane1Id, "pre-sync-pane1", 8_000);
          // pane2 must NOT have pane1's output.
          assert.ok(
            !accumulatedOutput(hook, pane2Id).includes(Buffer.from("pre-sync-pane1")),
            "pane2 must not have pane1 output before sync",
          );

          // Step 3: derive wire WindowId from pane1Id ("p1" → pane1 is in window "w1").
          // We get the windowId from the mirror's model (via the hook).
          const windowId = (pane2Info as { windowId: string }).windowId as string;
          assert.ok(
            typeof windowId === "string" && windowId.startsWith("w"),
            `windowId must be a wire WindowId, got: ${windowId}`,
          );

          // Step 4 (SP1): enable synchronize-panes via the BROKER command path.
          //
          // This sends a set-synchronize-panes WireCommand through the session-proxy's
          // input-path, which: (a) sends `set-option -wt @N synchronize-panes on`
          // to tmux, and (b) immediately injects an optimistic model update via
          // injectNotification (tc-7xv.12 fix).  No external CLI or polling needed.
          controller.sendCommand({
            kind: "set-synchronize-panes",
            windowId: windowId as import("../wire/ids.js").WindowId,
            on: true,
          });

          // Step 5 (SP1): wait for the optimistic model update to be reflected
          // in the session-proxy model.  injectNotification fires synchronously, so
          // the model should already be updated by the time we poll here.
          const syncModel = await waitFor(
            () => {
              const m = session.sessionProxy.pipeline.getModel();
              const win = m.windows.get(windowId as import("../wire/ids.js").WindowId);
              if (win?.synchronizePanes === true) return win;
              return undefined;
            },
            5_000,
            "window.synchronizePanes did not become true in session-proxy model",
          );
          assert.equal(syncModel.synchronizePanes, true, "session-proxy model: synchronizePanes must be true");

          // Step 6 (SP2 — the REGRESSION criterion): send input to pane1 only.
          // With sync ON, tmux broadcasts to all panes natively (§4.5 VERIFIED).
          const syncMarker = `sync-broadcast-${Date.now()}`;
          controller.sendInput(pane1Id, `echo ${syncMarker}\n`);

          // Wait for pane1 to receive the echo.
          await waitForOutput(hook, pane1Id, syncMarker, 12_000);

          // CORE ASSERTION: pane2 MUST also contain the marker (native tmux broadcast).
          await waitForOutput(hook, pane2Id, syncMarker, 12_000);

          const pane2Bytes = accumulatedOutput(hook, pane2Id);
          assert.ok(
            pane2Bytes.includes(Buffer.from(syncMarker)),
            `REGRESSION: pane2 must receive the broadcast marker "${syncMarker}" ` +
            `when synchronize-panes is on (§4.5 VERIFIED). Got ${pane2Bytes.length} bytes.`,
          );

          // Step 7 (SP3): turn sync off via the server-proxy command path.
          controller.sendCommand({
            kind: "set-synchronize-panes",
            windowId: windowId as import("../wire/ids.js").WindowId,
            on: false,
          });

          // Wait for the optimistic model update to reflect sync=off.
          await waitFor(
            () => {
              const m = session.sessionProxy.pipeline.getModel();
              const win = m.windows.get(windowId as import("../wire/ids.js").WindowId);
              if (win?.synchronizePanes === false) return win;
              return undefined;
            },
            5_000,
            "window.synchronizePanes did not become false after sync off",
          );

          // Verify independence restored: pane1 echo does not appear in pane2.
          const postSyncMarker = `post-sync-${Date.now()}`;
          controller.sendInput(pane1Id, `echo ${postSyncMarker}\n`);
          await waitForOutput(hook, pane1Id, postSyncMarker, 8_000);
          // Brief wait for any stray broadcast that would falsify the test.
          await new Promise<void>((r) => setTimeout(r, 800));
          const pane2PostBytes = accumulatedOutput(hook, pane2Id);
          assert.ok(
            !pane2PostBytes.includes(Buffer.from(postSyncMarker)),
            `pane2 must NOT receive pane1 output after synchronize-panes is off`,
          );
        } finally {
          await session.teardown();
        }
      },
    );
  },
);
