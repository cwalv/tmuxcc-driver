/**
 * tc-295a.8 / tc-295a.9 — SP-level attach + hydration ordering tests.
 *
 * These exercise the COMPOSITION that `session-proxy.ts` wires up
 * (`makeSentinels` + `attachAndHydratePane`) using the same exported primitives
 * — `hydratePane` / `hydrateTransport` (hydration.ts) and the real
 * `createOutputDemux` queue gate — plus a minimal fake of the ControlServer's
 * `sendDirected` seq-stamping. The full createSessionProxy assembly always
 * builds its own real TmuxHost, so reconstructing the orchestration here lets us
 * assert the WIRE CONTRACT deterministically without spawning tmux.
 *
 * The pieces under test are the durable part (the bead notes tc-2x3.3 will
 * re-touch the impl): the message shapes + the ordering guarantee.
 *
 * Coverage (the ACs the bead names):
 *   1. attach-to-vanished-pane → pane.attach.failed{pane.not-found} (no
 *      hydration sentinels, no data frame).
 *   2. attach-to-live-pane → pane.hydration.begin → (clear+replay frame) →
 *      pane.hydration.end, in that order.
 *   3. live-bytes-during-hydration are QUEUED and replayed AFTER the clear+
 *      replay frame and BEFORE pane.hydration.end's effect — no interleave.
 *
 * @module runtime/attach-hydration.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createOutputDemux } from "./output-demux.js";
import { hydratePane, hydrateTransport, CLEAR_AND_SCROLLBACK } from "./hydration.js";
import type { HydrationPipeline, HydrationSentinels } from "./hydration.js";
import { createFlowController } from "./flow-control.js";
import { createInMemoryTransportPair } from "@tmuxcc/protocol";
import { paneId } from "@tmuxcc/protocol";
import type { PaneId } from "@tmuxcc/protocol";
import type { Transport } from "@tmuxcc/protocol";
import type { CommandResult } from "../parser/correlator.js";

const P1 = paneId("p1");
const P9 = paneId("p9");

// ---------------------------------------------------------------------------
// Fakes mirroring the session-proxy.ts closure
// ---------------------------------------------------------------------------

/** Fake pipeline: scripted capture-pane replies, keyed by `-t %N` prefix. */
function makePipeline(replies: Map<string, CommandResult | "reject">): {
  pipeline: HydrationPipeline;
  sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    pipeline: {
      send(command: string): Promise<CommandResult> {
        sent.push(command);
        for (const [prefix, reply] of replies) {
          if (command.startsWith(prefix)) {
            if (reply === "reject") return Promise.reject(new Error("reject"));
            return Promise.resolve(reply);
          }
        }
        return Promise.resolve({ ok: true, commandNumber: 0, body: new Uint8Array(0) });
      },
    },
  };
}

/**
 * A unified ordered event log: control messages (via sendDirected) and data
 * frames (via the demux fan-out / hydrator) land in ONE array so we can assert
 * cross-plane ordering exactly.
 */
type LogEntry =
  | { kind: "control"; type: string; paneId?: PaneId | undefined }
  | { kind: "data"; paneId: PaneId; bytes: Uint8Array };

function ok(body: Uint8Array): CommandResult {
  return { ok: true, commandNumber: 0, body };
}

/**
 * Reconstruct the session-proxy.ts orchestration over the REAL demux + the
 * exported hydration primitives.
 */
function makeHarness() {
  const demux = createOutputDemux();
  const { sessionProxy, client } = createInMemoryTransportPair();
  const log: LogEntry[] = [];

  // Data frames the client receives (live fan-out AND hydrator-direct frames).
  client.onData((pid, bytes) => log.push({ kind: "data", paneId: pid, bytes }));

  demux.attachTransport(sessionProxy);

  // Fake ControlServer.sendDirected (seq-stamp omitted — we log the type).
  function sendDirected(msg: { type: string; paneId?: PaneId }): void {
    log.push({ kind: "control", type: msg.type, paneId: msg.paneId });
  }

  function makeSentinels(): HydrationSentinels {
    return {
      begin(pid: PaneId): void {
        demux.beginPaneHydration(sessionProxy, pid);
        sendDirected({ type: "pane.hydration.begin", paneId: pid });
      },
      end(pid: PaneId): void {
        demux.endPaneHydration(sessionProxy, pid);
        sendDirected({ type: "pane.hydration.end", paneId: pid });
      },
    };
  }

  return { demux, sessionProxy, client, log, sendDirected, makeSentinels };
}

// ---------------------------------------------------------------------------
// AC 1 — attach to a vanished pane → pane.not-found
// ---------------------------------------------------------------------------

describe("tc-295a.8 attach-to-vanished-pane", () => {
  it("model-absent pane: emits pane.attach.failed{pane.not-found}, no hydration", async () => {
    const h = makeHarness();
    // attachAndHydratePane's model check fails → fail-loud, skip capture.
    const modelHas = (_pid: PaneId): boolean => false;

    if (!modelHas(P9)) {
      h.sendDirected({ type: "pane.attach.failed", paneId: P9 });
    }

    const controls = h.log.filter((e) => e.kind === "control") as Array<{ type: string }>;
    assert.deepEqual(controls.map((c) => c.type), ["pane.attach.failed"]);
    assert.equal(h.log.filter((e) => e.kind === "data").length, 0, "no hydration frame for a vanished pane");
  });

  it("pane closes mid-capture (ok=false): hydratePane returns false → pane.not-found", async () => {
    const h = makeHarness();
    const { pipeline } = makePipeline(
      new Map([["capture-pane -t %9", { ok: false, commandNumber: 0, body: new Uint8Array(0) } as CommandResult]]),
    );
    const sentinels = h.makeSentinels();

    const found = await hydratePane(pipeline, h.sessionProxy, P9, sentinels);
    assert.equal(found, false, "ok=false capture → pane considered not found");
    if (!found) {
      h.sendDirected({ type: "pane.attach.failed", paneId: P9 });
    }

    const controls = h.log.filter((e) => e.kind === "control") as Array<{ type: string }>;
    // begin + end (window opened/closed even though capture failed) + failure.
    assert.deepEqual(controls.map((c) => c.type), [
      "pane.hydration.begin",
      "pane.hydration.end",
      "pane.attach.failed",
    ]);
    assert.equal(h.log.filter((e) => e.kind === "data").length, 0, "no data frame on failed capture");
  });
});

// ---------------------------------------------------------------------------
// AC 2 — attach to a live pane → hydrate then stream, in order
// ---------------------------------------------------------------------------

describe("tc-295a.8 attach-to-live-pane hydrate-then-stream", () => {
  it("emits begin → clear+replay data frame → end, in that order", async () => {
    const h = makeHarness();
    h.demux.notifyPaneBound(P1);
    const captureBody = new TextEncoder().encode("history-line");
    const { pipeline } = makePipeline(new Map([["capture-pane -t %1", ok(captureBody)]]));

    const found = await hydratePane(pipeline, h.sessionProxy, P1, h.makeSentinels());
    assert.equal(found, true);

    const types = h.log.map((e) => (e.kind === "control" ? `C:${e.type}` : `D`));
    assert.deepEqual(types, ["C:pane.hydration.begin", "D", "C:pane.hydration.end"]);

    // The data frame is CLEAR_AND_SCROLLBACK + replay body.
    const dataEntry = h.log.find((e) => e.kind === "data") as { bytes: Uint8Array };
    assert.deepEqual(dataEntry.bytes.subarray(0, CLEAR_AND_SCROLLBACK.length), CLEAR_AND_SCROLLBACK);
    assert.equal(
      new TextDecoder().decode(dataEntry.bytes.subarray(CLEAR_AND_SCROLLBACK.length)),
      "history-line",
    );
  });

  it("live deltas after end stream normally (live pass-through restored)", async () => {
    const h = makeHarness();
    h.demux.notifyPaneBound(P1);
    const { pipeline } = makePipeline(new Map([["capture-pane -t %1", ok(new Uint8Array(0))]]));

    await hydratePane(pipeline, h.sessionProxy, P1, h.makeSentinels());
    // Post-end live byte fans out immediately.
    h.demux.store.append(P1, new Uint8Array([0x7a]));

    const last = h.log[h.log.length - 1];
    assert.equal(last!.kind, "data");
    assert.deepEqual((last as { bytes: Uint8Array }).bytes, new Uint8Array([0x7a]));
  });
});

// ---------------------------------------------------------------------------
// AC 3 — live bytes during hydration are queued (no interleave)
// ---------------------------------------------------------------------------

describe("tc-295a.9 live-bytes-during-hydration queueing", () => {
  it("queues live bytes arriving during the capture RTT; replays them after the clear+replay frame, before end takes effect", async () => {
    const h = makeHarness();
    h.demux.notifyPaneBound(P1);

    // A pipeline whose capture reply is deferred so we can inject a live byte
    // INTO the hydration window (between begin and the reply). The follow-up
    // grid-facts read (display-message) resolves immediately — only the capture
    // is held open (tc-w3ir.2).
    let resolveCapture!: (r: CommandResult) => void;
    const pipeline: HydrationPipeline = {
      send(command: string): Promise<CommandResult> {
        if (command.startsWith("display-message")) {
          return Promise.resolve(ok(new Uint8Array(0)));
        }
        return new Promise<CommandResult>((res) => { resolveCapture = res; });
      },
    };

    const hydrationDone = hydratePane(pipeline, h.sessionProxy, P1, h.makeSentinels());

    // Let begin() run (microtask) so the window is open.
    await Promise.resolve();

    // Live byte arrives DURING hydration → must be queued, not fanned out.
    h.demux.store.append(P1, new Uint8Array([0xaa]));
    assert.equal(
      h.log.filter((e) => e.kind === "data").length,
      0,
      "live byte during hydration must NOT have been delivered yet",
    );

    // Capture reply arrives → hydrator delivers clear+replay, then end flushes queue.
    resolveCapture(ok(new TextEncoder().encode("REPLAY")));
    await hydrationDone;

    // Expected order: begin, clear+replay frame, queued live byte, end.
    const types = h.log.map((e) => (e.kind === "control" ? `C:${e.type}` : `D`));
    assert.deepEqual(types, ["C:pane.hydration.begin", "D", "D", "C:pane.hydration.end"]);

    const dataFrames = h.log.filter((e) => e.kind === "data") as Array<{ bytes: Uint8Array }>;
    // First data frame = clear+replay; second = the queued live byte.
    assert.deepEqual(dataFrames[0]!.bytes.subarray(0, CLEAR_AND_SCROLLBACK.length), CLEAR_AND_SCROLLBACK);
    assert.equal(
      new TextDecoder().decode(dataFrames[0]!.bytes.subarray(CLEAR_AND_SCROLLBACK.length)),
      "REPLAY",
    );
    assert.deepEqual(dataFrames[1]!.bytes, new Uint8Array([0xaa]), "queued live byte replays after the replay frame");
  });

  it("bulk addClient-style hydrate of multiple panes frames each with its own begin/end", async () => {
    const h = makeHarness();
    h.demux.notifyPaneBound(P1);
    h.demux.notifyPaneBound(P9);
    const { pipeline } = makePipeline(
      new Map([
        ["capture-pane -t %1", ok(new TextEncoder().encode("a"))],
        ["capture-pane -t %9", ok(new TextEncoder().encode("b"))],
      ]),
    );

    await hydrateTransport(pipeline, h.sessionProxy, [P1, P9], h.makeSentinels());

    // Each pane: begin + 1 data frame + end. Order across panes may interleave
    // (concurrent), but per pane the begin precedes its data which precedes end.
    function paneSeq(pid: PaneId): string[] {
      return h.log
        .filter((e) => (e.kind === "control" ? e.paneId === pid : e.paneId === pid))
        .map((e) => (e.kind === "control" ? `C:${e.type}` : "D"));
    }
    assert.deepEqual(paneSeq(P1), ["C:pane.hydration.begin", "D", "C:pane.hydration.end"]);
    assert.deepEqual(paneSeq(P9), ["C:pane.hydration.begin", "D", "C:pane.hydration.end"]);
  });
});

// ---------------------------------------------------------------------------
// tc-t4k1 — FC-1 drain over-credit regression.
//
// Root cause: the session-proxy.ts addClient wiring credited fc.noteDrained on
// EVERY sendData call of the per-client draining wrapper. The hydration replay
// frame (capture-pane body + CLEAR_AND_SCROLLBACK escape) is delivered via a
// direct sendData — its bytes were NEVER counted by fc.onPaneBytes (they come
// from capture-pane, not the live %output append path). So the wrapper credited
// drain for bytes the FC-1 ledger never held → noteDrained's byteCount exceeded
// buffered → the "DRAIN CLAMPED" tripwire fired (onDrainClamped). It fired only
// on panes WITH scrollback history (big replay body) and not on clean fresh
// creates (small replay body) — exactly the production trigger pinning.
//
// Fix: the replay frame is delivered on the RAW transport, never the draining
// wrapper, so only counted live %output reaches fc.noteDrained. The harness
// below mirrors the exact session-proxy.ts wiring (accounting store →
// onPaneBytes; per-client draining wrapper → noteDrained) and asserts the clamp
// NEVER fires across attach-then-stream.
// ---------------------------------------------------------------------------

/**
 * Reconstruct the session-proxy.ts FC wiring over the REAL demux + flow
 * controller + the exported hydration primitives.
 *
 * - `accountingStore.append` calls `fc.onPaneBytes` (the only ledger credit).
 * - the demux fans live %output out to `drainingTransport`.
 * - `drainingTransport.sendData` calls `fc.noteDrained` on drain (in-memory
 *   transport is synchronous → credit fires immediately, the `void` branch).
 * - the replay frame is delivered on the bare `replayTransport` per the fix.
 */
function makeFcHarness() {
  const demux = createOutputDemux();
  const { sessionProxy: rawTransport, client } = createInMemoryTransportPair();
  client.onData(() => {}); // sink — we only care about FC accounting

  const clamps: Array<{ pane: PaneId; excess: number }> = [];
  const fc = createFlowController(
    () => new Promise<CommandResult>(() => {}), // fire-and-forget send
    demux,
    {
      // Small water marks so a modest flood exercises pause/resume too.
      highWaterBytes: 4_000,
      lowWaterBytes: 1_000,
      metrics: {
        onDrainClamped: (pane, excess) => clamps.push({ pane, excess }),
      },
    },
  );

  // Per-client draining wrapper — mirrors session-proxy.ts addClient exactly:
  // register the client and credit ITS sub-ledger (keyed by the raw
  // transport, tc-0wtb).
  fc.addClient(rawTransport);
  const drainingTransport: Transport = {
    ...rawTransport,
    sendData(pid: PaneId, bytes: Uint8Array): void | Promise<void> {
      const result = rawTransport.sendData(pid, bytes);
      if (bytes.length === 0) return result;
      if (result !== undefined && typeof (result as Promise<void>).then === "function") {
        return (result as Promise<void>).then(() => fc.noteDrained(pid, bytes.length, rawTransport));
      }
      fc.noteDrained(pid, bytes.length, rawTransport);
      return undefined;
    },
  };
  demux.attachTransport(drainingTransport);

  // Accounting store wrapper — mirrors session-proxy.ts accountingStore.
  // tc-t4k1: COUNT BEFORE FAN-OUT — onPaneBytes(+n) must run before
  // demux.store.append fans out (which synchronously drains → noteDrained(-n)
  // for an un-backpressured transport). Counting first makes the credit-before-
  // debit inversion impossible.
  const append = (pid: PaneId, bytes: Uint8Array): void => {
    if (bytes.length > 0) fc.onPaneBytes(pid, bytes.length);
    demux.store.append(pid, bytes);
  };

  // Sentinels gate the DRAINING transport (the demux fan-out target), matching
  // makeSentinels(controlTransport=raw, dataTransport=draining).
  const sentinels: HydrationSentinels = {
    begin(pid: PaneId): void {
      demux.beginPaneHydration(drainingTransport, pid);
    },
    end(pid: PaneId): void {
      demux.endPaneHydration(drainingTransport, pid);
    },
  };

  return { demux, rawTransport, drainingTransport, fc, append, sentinels, clamps };
}

describe("tc-t4k1 FC-1 drain over-credit on hydration", () => {
  it("hydrating a pane with scrollback history does NOT trip the DRAIN CLAMPED tripwire", async () => {
    const h = makeFcHarness();
    h.demux.notifyPaneBound(P1);

    // A pane that produced real output before this client attached. The replay
    // body is large (the production trigger: panes WITH history).
    const captureBody = new TextEncoder().encode("scrollback ".repeat(500)); // ~5.5 KiB
    const { pipeline } = makePipeline(new Map([["capture-pane -t %1", ok(captureBody)]]));

    // Hydrate: per the fix, the replay frame is delivered on the RAW transport.
    await hydratePane(pipeline, h.rawTransport, P1, h.sentinels);

    assert.deepEqual(
      h.clamps,
      [],
      "replay bytes were never counted by onPaneBytes — crediting them via " +
        "noteDrained over-credits the FC-1 ledger and trips the clamp",
    );
    // The ledger is untouched by hydration: no live %output was appended.
    assert.equal(h.fc.bufferedBytes(P1), 0, "hydration must not move the FC ledger");
  });

  it("attach-then-stream stays balanced: live %output drains exactly, clamp never fires", async () => {
    const h = makeFcHarness();
    h.demux.notifyPaneBound(P1);

    const captureBody = new TextEncoder().encode("old-history ".repeat(300));
    const { pipeline } = makePipeline(new Map([["capture-pane -t %1", ok(captureBody)]]));
    await hydratePane(pipeline, h.rawTransport, P1, h.sentinels);

    // Now a live flood through the accounting store: onPaneBytes(+n) per append,
    // demux fans out to the draining wrapper → noteDrained(-n) on synchronous
    // in-memory drain. Each appended byte is counted once and drained once.
    for (let i = 0; i < 50; i++) {
      h.append(P1, new TextEncoder().encode("live-output-chunk\n"));
    }

    assert.deepEqual(h.clamps, [], "balanced live accounting must never clamp");
    assert.equal(h.fc.bufferedBytes(P1), 0, "every appended byte was drained exactly once");
  });

  it("over-crediting un-buffered bytes DOES trip the clamp (guards the harness fidelity)", () => {
    // Negative control: prove the harness's clamp hook is live by driving the
    // exact illegal accounting the fix prevents — crediting drain for bytes the
    // ledger never held. If this did not clamp, the positive tests above would
    // be vacuous.
    const h = makeFcHarness();
    h.fc.noteDrained(P1, 1_234, h.rawTransport); // no prior onPaneBytes → pure over-credit
    assert.equal(h.clamps.length, 1, "drain for un-buffered bytes must clamp");
    assert.equal(h.clamps[0]!.excess, 1_234);
  });
});
