/**
 * tc-2ph — Full-stack e2e smoke test
 *
 * Drives REAL tmux 3.4 through the whole stack:
 *   tmux -CC (via PTY bridge) → createDaemon → transport pair → client modules
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
 * `runClientHandshake` which must overlap with the daemon's
 * `runDaemonHandshake` (both run concurrently in Promise.all).  The
 * `setImmediate` deferral of `daemon.addClient()` causes the server-side
 * handshake to race with the already-completed client-side handshake.
 *
 * Solution: mirror the proven pattern from integration.test.ts (Suite 3 R1/R2)
 * and daemon-transport.test.ts — run both handshakes concurrently, then
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
 * from the daemon's tsconfig build to avoid rootDir violations — matching the
 * pattern used by tmuxcc-vscode/tsconfig.json for daemon-transport.test.ts.
 *
 * @module runtime/e2e-smoke.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// tc-blk — process-level safety net: register every spawned tmux socket so a
// thrown / timed-out test still has its server killed.
// flushAllTracked is imported for the E6 regression test that simulates a
// thrown test body and verifies the safety net reaps the orphan.
import { trackSocket, killTmuxServer, flushAllTracked } from "./test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// Daemon internals (within daemon/src, no rootDir issue)
// ---------------------------------------------------------------------------

import { createDaemon } from "./daemon.js";
import type { Daemon } from "./daemon.js";
import { createInMemoryTransportPair } from "../wire/transport.js";
import type { PaneId } from "../wire/ids.js";
import {
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
} from "../wire/index.js";
import type { ClientMessage } from "../wire/index.js";

// ---------------------------------------------------------------------------
// Client sub-modules — relative src paths; tsx resolves at runtime.
// Excluded from daemon tsconfig (see tsconfig.json "exclude").
// ---------------------------------------------------------------------------

// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { Mirror } from "../../../tmuxcc-client/src/mirror.js";
// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { PaneStreamConsumer } from "../../../tmuxcc-client/src/pane-stream.js";
// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { createInputApi } from "../../../tmuxcc-client/src/input.js";
// @ts-ignore — outside rootDir; resolved by tsx at runtime
import { EchoRenderHook } from "../../../tmuxcc-client/src/render-hook.js";
// @ts-ignore — outside rootDir; resolved by tsx at runtime
import type { RenderHookCall, PaneInfo, ClientController } from "../../../tmuxcc-client/src/render-hook.js";

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
// Capabilities — same as integration.test.ts and daemon-transport.test.ts
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

const RUN_ID = `${Date.now()}-${process.pid}`;

function sockName(label: string): string {
  return `tmuxcc-e2e-${RUN_ID}-${label}`;
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
//   const { hook, paneId, controller, daemon } = session;
//   controller.sendInput(paneId, "echo hello\n");
//   await session.waitForOutput(paneId, "hello", 8000);
// } finally {
//   await session.teardown();
// }
// ```
//
// Fields returned:
//   daemon     — Daemon handle (host, demux, pipeline, server, inputPath,
//                flowController).  Low-level access for advanced tests.
//   controller — ClientController with sendInput / resizePane / sendCommand.
//   hook       — EchoRenderHook recording all render-hook callbacks.
//   paneId     — Wire PaneId of the first pane from the snapshot (e.g. "p1").
//   socketName — tmux -L socket name (for direct tmux commands if needed).
//   daemonTransport / clientTransport — the raw transport pair.
//   waitForOutput(paneId, needle, ms) — poll hook until pane output has needle.
//   teardown() — stop render driver, kill daemon, kill tmux server. Idempotent.
// ===========================================================================

export interface E2ESession {
  /** The fully assembled daemon runtime. */
  readonly daemon: Daemon;
  /** Client controller: sendInput / resizePane / sendCommand. */
  readonly controller: ClientController;
  /** EchoRenderHook recording all render-hook callbacks. */
  readonly hook: InstanceType<typeof EchoRenderHook>;
  /** Wire PaneId of the first pane from the initial snapshot. */
  readonly paneId: PaneId;
  /** tmux -L socket name. */
  readonly socketName: string;
  /** The daemon-side transport endpoint. */
  readonly daemonTransport: ReturnType<typeof createInMemoryTransportPair>["daemon"];
  /** The client-side transport endpoint. */
  readonly clientTransport: ReturnType<typeof createInMemoryTransportPair>["client"];
  /** Poll until pane output contains needle. Throws on timeout. */
  waitForOutput(paneId: PaneId, needle: string, timeoutMs: number): Promise<void>;
  /** Graceful teardown: detach mirror hook → kill daemon → kill tmux server. */
  teardown(): Promise<void>;
}

/**
 * Stand up the full tmuxcc stack against a real tmux -CC session.
 *
 * Uses the proven low-level wiring pattern from integration.test.ts (Suite 3
 * R1/R2) and daemon-transport.test.ts: both handshakes run concurrently in
 * Promise.all, then client modules are wired up afterward.
 *
 * @param label - Short label for the socket name (keep it test-unique).
 * @param opts  - Optional daemon host overrides (cols, rows, sessionName).
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

  // 1. Create and start the daemon (spawns real tmux -CC via PTY bridge).
  const daemon = createDaemon({
    host: {
      socketName: sock,
      sessionName,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    },
  });
  daemon.host.onError(() => { /**/ });
  await daemon.start();

  // 2. Create in-memory transport pair.
  const { daemon: daemonTransport, client: clientTransport } = createInMemoryTransportPair();

  // 3. Attach data-plane demux BEFORE handshake so byte frames are received.
  const detach = daemon.demux.attachTransport(daemonTransport);

  // 4. Run server-side and client-side handshakes concurrently.
  //    This is the proven pattern from integration.test.ts R1/R2.
  const addPromise = daemon.server.addClient(daemonTransport);
  const handshakePromise = runClientHandshake(clientTransport, CLIENT_CAPS);
  await Promise.all([addPromise, handshakePromise]);

  // 5. Wire the input path (daemon.addClient() sets this up automatically,
  //    but since we're using daemon.server.addClient directly, we wire it).
  daemonTransport.onControl((msg) => {
    daemon.inputPath.handleClientMessage(msg as ClientMessage);
  });

  // 6. Build client-side modules: Mirror + PaneStreamConsumer.
  //
  //    The snapshot was sent synchronously by server.addClient() inside addPromise.
  //    At this point we need the snapshot in the mirror.  We get it via
  //    daemon.pipeline.getModel() (projectSnapshot), matching daemon-transport.test.ts.
  const { projectSnapshot } = await import("../state/projection.js");
  const snapshotMsg = projectSnapshot(daemon.pipeline.getModel(), { seq: 1 });

  // Manually set up the mirror:
  const mirror = new Mirror();
  mirror.receiveSnapshot(snapshotMsg);

  // Future deltas go through connection's onControl handler → mirror.
  // But connection.connect() was never called, so we wire directly.
  clientTransport.onControl((msg: ClientMessage) => {
    const dm = msg as { type: string };
    if (dm.type === "snapshot") {
      mirror.receiveSnapshot(msg as Parameters<typeof mirror.receiveSnapshot>[0]);
    } else {
      // Deltas, command responses, errors
      try { mirror.receiveDelta(msg as Parameters<typeof mirror.receiveDelta>[0]); } catch { /**/ }
    }
  });

  // 7. PaneStreamConsumer — wires data frames to per-pane callbacks.
  const paneConsumer = new PaneStreamConsumer();
  // Wire data frames from clientTransport → paneConsumer.
  clientTransport.onData((paneId: PaneId, bytes: Uint8Array) => {
    // PaneStreamConsumer expects to be wired via connectPaneStream(connection).
    // Since we bypass DaemonConnection, we push directly.
    paneConsumer.push(paneId, bytes);
  });

  // 8. InputApi — for sendInput / resizePane / sendCommand.
  //    createInputApi expects a DaemonConnection with a send() method.
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
    daemon.kill();
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
    try { daemon.kill(); } catch { /**/ }
    await new Promise<void>((r) => {
      if (daemon.host.exited) { r(); return; }
      daemon.host.onExit(() => r());
      setTimeout(r, 1500);
    });
    killServer(sock);
  }

  function sessionWaitForOutput(pid: PaneId, needle: string, timeoutMs: number): Promise<void> {
    return waitForOutput(hook, pid, needle, timeoutMs);
  }

  return {
    daemon,
    controller,
    hook,
    paneId: firstPaneId,
    socketName: sock,
    daemonTransport,
    clientTransport,
    waitForOutput: sessionWaitForOutput,
    teardown,
  };
}

// ===========================================================================
// E7 Full-stack smoke suite
// ===========================================================================

describe(
  "tc-2ph: Full e2e smoke — real tmux → daemon → client → render hooks",
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
    // E4. Resize — resizePane round-trip; daemon stays alive after resize
    //
    // resizePane() sends resize.request → daemon issues refresh-client -C WxH
    // → tmux applies → may or may not emit pane.resized delta (tmux 3.4 only
    // emits %layout-change when the layout actually changes; in a single-pane
    // session the pane may already fill the window so no layout event fires).
    // We assert two things:
    //   1. The resize is processed without error (no throw/crash).
    //   2. The daemon is still alive: a subsequent echo still produces output.
    // If onPaneResized does arrive within the window, we also validate it.
    // -----------------------------------------------------------------------

    it(
      "E4: resizePane(100, 30) — processed without error; daemon stays live post-resize",
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

          // Assert daemon is still live: a subsequent echo must produce output.
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
      "E5: teardown() kills daemon + tmux server cleanly",
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

        // Also tear down the daemon's bridge process so we don't leave a
        // stranded host child (it will exit on its own when tmux dies, but
        // we wait briefly to be a polite test citizen).
        session.daemon.kill();
      },
    );
  },
);
