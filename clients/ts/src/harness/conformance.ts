/**
 * conformance.ts — the protocol conformance runner (tc-ozk.4 / W3.2).
 *
 * Replays ONE transcript two ways and asserts both sides agree with it. This is
 * the artifact that makes "the protocol is the product" enforceable in CI: the
 * SAME transcript pins the SDK's parser/mirror AND the real session-proxy daemon.
 *
 *   conformClientToTranscript(t)
 *     The SDK side: a REAL `connectClient` consumes a `runStubDaemon(t)` daemon.
 *     Asserts the client's mirror catches up to the model the transcript builds,
 *     that this client learns its own connectionId, and that creating verbs
 *     round-trip with the right effect ids (tc-ozk.1) + origin (tc-ozk.2), and
 *     that pane.capture returns the transcript's payload (tc-295a.11).
 *
 *   conformDaemonToTranscript(t)
 *     The daemon side: the REAL `createControlServer` (seeded with the
 *     transcript's initialModel via a fake pipeline + a real VerbOriginRegistry)
 *     is driven by a transcript-replaying client. Asserts the daemon emits the
 *     transcript's session-proxy→client snapshot + deltas (origin-tagged) and
 *     command.response payloads — shape-equal, ignoring per-connection seq.
 *
 * # Fail-loud (epic policy)
 *
 * Any mismatch throws a named `TranscriptError`. There is no "skip on mismatch"
 * path; a conformance mismatch is a hard CI failure.
 *
 * @module harness/conformance
 */

import assert from "node:assert/strict";

import { createInMemoryTransportPair, runClientHandshake, WIRE_PROTOCOL_VERSION } from "@tmuxcc/protocol";
import { createControlServer, createVerbOriginRegistry } from "@tmuxcc/driver";
import type { Transport, ControlMessage, SessionProxyMessage, SessionProxyCommandRequestMessage, SessionProxyCommandResponseMessage, InputMessage, ResizeRequestMessage, WireCommand, PaneId } from "@tmuxcc/protocol";

import { connectClient } from "../client.js";
import { applySnapshot, applyDelta } from "../mirror.js";
import type { ClientModel, PaneNotifyEvent } from "../mirror.js";
import type { VerbResult } from "../input.js";

import { TranscriptError, serverSteps } from "./transcript.js";
import type { Transcript, ServerStep, ClientStep } from "./transcript.js";
import { runStubDaemon } from "./stub-daemon.js";
import { createFakePipeline } from "./fake-pipeline.js";
import { buildModel, applyVerbCreate } from "./model-builder.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new TranscriptError(msg);
}

/** Build the "oracle" client model by applying the transcript's pushes in order. */
function oracleModel(t: Transcript): ClientModel {
  let model: ClientModel | undefined;
  for (const s of serverSteps(t)) {
    if (s.message.type === "snapshot") {
      model = applySnapshot(s.message).model;
    } else if (model !== undefined) {
      model = applyDelta(model, s.message);
    }
  }
  if (model === undefined) fail("transcript has no snapshot step — cannot build oracle model");
  return model;
}

/** Deep-compare two client models on the fields the wire is responsible for. */
function assertModelsEqual(actual: ClientModel, expected: ClientModel, ctx: string): void {
  assert.deepEqual(actual.session, expected.session, `${ctx}: session mismatch`);
  assert.deepEqual(actual.focus, expected.focus, `${ctx}: focus mismatch`);
  assert.deepEqual(actual.ownConnectionId, expected.ownConnectionId, `${ctx}: ownConnectionId mismatch`);
  assert.deepEqual(
    [...actual.panes.keys()].sort(),
    [...expected.panes.keys()].sort(),
    `${ctx}: pane id set mismatch`,
  );
  assert.deepEqual(
    [...actual.windows.keys()].sort(),
    [...expected.windows.keys()].sort(),
    `${ctx}: window id set mismatch`,
  );
  for (const [pid, ep] of expected.panes) {
    const ap = actual.panes.get(pid);
    if (ap === undefined) fail(`${ctx}: pane ${pid} missing from actual model`);
    assert.deepEqual(ap.origin, ep.origin, `${ctx}: pane ${pid} origin mismatch`);
    assert.equal(ap.cols, ep.cols, `${ctx}: pane ${pid} cols mismatch`);
    assert.equal(ap.rows, ep.rows, `${ctx}: pane ${pid} rows mismatch`);
  }
}

// ---------------------------------------------------------------------------
// SDK side — the client (parser + mirror) conforms
// ---------------------------------------------------------------------------

/**
 * Replay `t` against a REAL `connectClient` + a `runStubDaemon` daemon.
 *
 * Steps:
 *   1. Wire a transport pair; run the stub daemon on the session-proxy side and
 *      `connectClient` on the client side. After connect resolves, the snapshot
 *      has been applied to the client mirror.
 *   2. For each client→session-proxy step, drive the client API:
 *        - input        → controller.sendInput
 *        - resize.request → controller.resizePane
 *        - command.request, CREATING verb (open-window/split-pane/break-pane) →
 *          handle.sendVerb, asserting the returned effect ids (tc-ozk.1)
 *        - command.request, pane.capture (and any non-creating verb) →
 *          controller.sendCommand + mirror.onCommandResponse, asserting the
 *          {text} / {ok:false,code} payload (tc-295a.11). sendVerb is the
 *          effect-id seam ONLY; non-creating verbs use the command-response seam.
 *        - resync.request → (skipped; deltas push proactively)
 *   3. Await all daemon pushes, then assert the client's mirror == oracle model.
 */

/** Command kinds that create a pane/window and return effect ids (tc-ozk.1). */
const CREATING_VERB_KINDS = new Set<string>(["open-window", "split-pane", "break-pane"]);

export async function conformClientToTranscript(t: Transcript): Promise<void> {
  if (t.protocolVersion !== WIRE_PROTOCOL_VERSION) {
    fail(`transcript protocolVersion != WIRE_PROTOCOL_VERSION`);
  }

  const { sessionProxy: daemonTransport, client: clientTransport } = createInMemoryTransportPair();

  const daemon = runStubDaemon(daemonTransport, t);
  const handle = await connectClient(clientTransport);

  // Collect every command.response the mirror observes, in arrival order — the
  // seam a renderer uses to read a non-creating verb's reply (e.g. pane.capture
  // {text}). FIFO-matched to the transcript's non-creating command.requests.
  const observedResponses: SessionProxyCommandResponseMessage["result"][] = [];
  const unsubResp = handle.mirror.onCommandResponse((msg) => {
    observedResponses.push(msg.result);
  });

  // tc-76m8.1 (S9): every pane.notify the mirror surfaces via onPaneNotify, in
  // arrival order — the seam the extension attention layer consumes.
  const observedNotifies: PaneNotifyEvent[] = [];
  const unsubNotify = handle.mirror.onPaneNotify((e) => {
    observedNotifies.push(e);
  });

  try {
    const verbResults = new Map<string, VerbResult>();
    for (const cs of t.transcript.filter((s): s is ClientStep => s.direction === "client→session-proxy")) {
      const m = cs.message;
      switch (m.type) {
        case "input": {
          const im = m as InputMessage;
          handle.controller.sendInput(im.paneId, im.data);
          break;
        }
        case "resize.request": {
          const rm = m as ResizeRequestMessage;
          handle.controller.resizePane(rm.paneId, rm.cols, rm.rows);
          break;
        }
        case "command.request": {
          const cm = m as SessionProxyCommandRequestMessage;
          if (CREATING_VERB_KINDS.has(cm.command.kind)) {
            // tc-ozk.1: creating verb — sendVerb resolves with effect ids.
            const result = await handle.sendVerb(cm.command as WireCommand);
            verbResults.set(cm.correlationId, result);
          } else {
            // tc-295a.11: non-creating verb (pane.capture) — fire-and-forget
            // sendCommand; the reply is observed via mirror.onCommandResponse.
            handle.controller.sendCommand(cm.command as WireCommand);
            // Let the response round-trip before driving the next step.
            await new Promise((r) => setImmediate(r));
          }
          break;
        }
        case "resync.request":
          break;
        default:
          break;
      }
    }

    await daemon.donePushing;
    await new Promise((r) => setImmediate(r));

    // Assert the client mirror matches the oracle.
    assertModelsEqual(handle.mirror.getModel(), oracleModel(t), "SDK-side mirror");

    // Assert CREATING verbs' effect ids (tc-ozk.1). Also build the ordered list
    // of EVERY scripted command.response — the mirror's onCommandResponse seam
    // observes them all (creating + non-creating), in command.request order.
    const allResponses: SessionProxyCommandResponseMessage["result"][] = [];
    for (const cs of t.transcript.filter((s): s is ClientStep => s.direction === "client→session-proxy")) {
      if (cs.message.type !== "command.request") continue;
      const cm = cs.message as SessionProxyCommandRequestMessage;
      const script = t.verbs[cm.correlationId];
      if (script === undefined) continue;
      allResponses.push(script.response);
      if (CREATING_VERB_KINDS.has(cm.command.kind)) {
        const result = verbResults.get(cm.correlationId);
        if (result === undefined) fail(`SDK-side: no VerbResult captured for ${cm.correlationId}`);
        assertVerbEffectIds(cm, script.response, result);
      }
    }

    // Assert command.response payloads observed via the mirror seam (tc-295a.11
    // pane.capture {text}/{ok:false,code}; also the creating verbs' replies).
    if (observedResponses.length !== allResponses.length) {
      fail(
        `SDK-side: expected ${allResponses.length} command.response(s) on the mirror seam ` +
          `but observed ${observedResponses.length}`,
      );
    }
    for (let i = 0; i < allResponses.length; i++) {
      assert.deepEqual(
        observedResponses[i],
        allResponses[i],
        `SDK-side: command.response #${i} payload mismatch (tc-ozk.1 / tc-295a.11)`,
      );
    }

    // tc-76m8.1 (S9): the mirror must surface every scripted pane.notify on the
    // onPaneNotify seam, in order, as {paneId, kind, payload?} (type/seq dropped).
    const expectedNotifies = serverSteps(t)
      .filter((s) => s.message.type === "pane.notify")
      .map((s) => {
        const m = s.message as Extract<SessionProxyMessage, { type: "pane.notify" }>;
        return m.payload === undefined
          ? { paneId: m.paneId, kind: m.kind }
          : { paneId: m.paneId, kind: m.kind, payload: m.payload };
      });
    assert.deepEqual(
      observedNotifies,
      expectedNotifies,
      "SDK-side: onPaneNotify surface mismatch (tc-76m8.1)",
    );
  } finally {
    unsubResp();
    unsubNotify();
    daemon.stop();
    handle.disconnect();
  }
}

/** Assert a CREATING verb's VerbResult carries the transcript's effect ids. */
function assertVerbEffectIds(
  req: SessionProxyCommandRequestMessage,
  response: import("./transcript.js").VerbScript["response"],
  result: VerbResult,
): void {
  const ctx = `verb ${req.correlationId} (kind=${req.command.kind})`;
  if (response.ok) {
    if (!result.ok) fail(`${ctx}: expected ok=true VerbResult, got ok=false (${(result as { code: string }).code})`);
    const payload = response.payload ?? {};
    if ("paneId" in payload && payload.paneId !== undefined) {
      assert.equal(result.newPaneId, payload.paneId, `${ctx}: newPaneId effect id mismatch (tc-ozk.1)`);
    }
    if ("windowId" in payload && payload.windowId !== undefined) {
      assert.equal(result.newWindowId, payload.windowId, `${ctx}: newWindowId effect id mismatch (tc-ozk.1)`);
    }
  } else {
    if (result.ok) fail(`${ctx}: expected ok=false VerbResult, got ok=true`);
    assert.equal(result.code, response.code, `${ctx}: error code mismatch`);
  }
}

// ---------------------------------------------------------------------------
// Daemon side — the real session-proxy conforms
// ---------------------------------------------------------------------------

/**
 * Replay `t` against the REAL `createControlServer` (no tmux).
 *
 * Steps:
 *   1. Seed a fake pipeline with the transcript's initialModel; create a real
 *      control server with a real VerbOriginRegistry as its originLookup.
 *   2. Connect a raw client over an in-memory transport (real handshake). Spy on
 *      the daemon-side `sendControl` to collect every session-proxy→client push.
 *   3. For each client→session-proxy step: send it to the daemon. For a creating
 *      verb (tc-ozk.1), FIRST record the verb origin in the registry, then
 *      mutate + fireChange the pipeline so the daemon emits the origin-tagged
 *      creation deltas (tc-ozk.2). For pane.capture / non-creating verbs, reply
 *      via the control server's command-response API with the scripted payload.
 *   4. Assert the collected daemon pushes match the transcript's
 *      session-proxy→client steps (shape-equal, ignoring per-connection seq).
 */
export async function conformDaemonToTranscript(t: Transcript): Promise<void> {
  if (t.protocolVersion !== WIRE_PROTOCOL_VERSION) {
    fail(`transcript protocolVersion != WIRE_PROTOCOL_VERSION`);
  }

  const sid = t.initialModel.session.sessionId;
  const initial = buildModel(t.initialModel);
  const pipeline = createFakePipeline(initial);
  const originRegistry = createVerbOriginRegistry();
  const server = createControlServer(pipeline, { originLookup: (id) => originRegistry.lookup(id) });

  const { sessionProxy: daemonTransport, client: clientTransport } = createInMemoryTransportPair();

  // Spy on outbound daemon pushes (skip the handshake advertisement).
  const pushed: SessionProxyMessage[] = [];
  const origSend = daemonTransport.sendControl.bind(daemonTransport);
  daemonTransport.sendControl = (msg: ControlMessage) => {
    if (msg.type !== "session-proxy.capabilities") {
      pushed.push(msg as SessionProxyMessage);
    }
    return origSend(msg);
  };

  // Default-size for created panes: take the focused pane's dims, else 80x24.
  const focusPaneId = t.initialModel.focus.paneId;
  const focusPane = t.initialModel.panes.find((p) => p.paneId === focusPaneId);
  const defaults = { cols: focusPane?.cols ?? 80, rows: focusPane?.rows ?? 24, sessionId: sid };

  // Run both handshakes; addClient sends the snapshot (seq=1) once resolved.
  const connectionIdSeen = { value: undefined as string | undefined };
  await Promise.all([
    server.addClient(daemonTransport),
    runClientHandshake(clientTransport, {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding"],
    }),
  ]);

  // Snapshot is now pushed. Record its connectionId for later assertions.
  const snap = pushed.find((m) => m.type === "snapshot");
  if (snap && snap.type === "snapshot") connectionIdSeen.value = snap.connectionId as string | undefined;

  const conn = server.connectionIdFor(daemonTransport);
  if (conn === undefined) fail("daemon-side: connectionId not assigned to client");

  // Drive the client→session-proxy steps against the real daemon.
  let model = initial;
  for (const cs of t.transcript.filter((s): s is ClientStep => s.direction === "client→session-proxy")) {
    const m = cs.message;
    if (m.type !== "command.request") {
      // input / resize.request / resync are not assertion targets here; the
      // daemon's responses to them (if any) are encoded as server steps.
      clientTransport.sendControl(m);
      continue;
    }
    const cm = m as SessionProxyCommandRequestMessage;
    const script = t.verbs[cm.correlationId];
    if (script === undefined) {
      fail(`daemon-side: command.request "${cm.correlationId}" has no verb script`);
    }

    if (script.creates) {
      // tc-ozk.1 + tc-ozk.2: record origin BEFORE the model change so diffModel
      // stamps the origin on the creation delta; reply with the effect ids; then
      // mutate + fire so the daemon emits the (origin-tagged) creation deltas.
      const c = script.creates;
      if (c.newPaneId !== undefined && c.newWindowId !== undefined) {
        originRegistry.record(c.newPaneId, c.newWindowId, conn, cm.correlationId);
      } else if (c.newPaneId !== undefined) {
        // split-pane: only a pane id; key the pane to the origin (window is the
        // existing focused window — diffModel keys pane.opened off the pane id).
        originRegistry.record(c.newPaneId, model.focus.windowId as never, conn, cm.correlationId);
      } else if (c.newWindowId !== undefined) {
        originRegistry.record(("p?" as PaneId), c.newWindowId, conn, cm.correlationId);
      }
      // Reply with the scripted command.response (effect ids).
      if (script.response.ok) {
        server.sendCommandResponse(daemonTransport, cm.correlationId, script.response.payload ?? {});
      } else {
        server.sendCommandError(daemonTransport, cm.correlationId, script.response.code, script.response.message ?? "");
      }
      const prev = model;
      model = applyVerbCreate(model, c, defaults);
      pipeline.fireChange(model, prev);
    } else {
      // Non-creating verb (e.g. pane.capture, tc-295a.11): reply only.
      if (script.response.ok) {
        server.sendCommandResponse(daemonTransport, cm.correlationId, script.response.payload ?? {});
      } else {
        server.sendCommandError(daemonTransport, cm.correlationId, script.response.code, script.response.message ?? "");
      }
    }
    // Let the daemon's synchronous fan-out settle.
    await Promise.resolve();
  }

  // tc-76m8.1 (S9): drive the transcript's pane.notify server steps through the
  // fake pipeline (the stand-in for the escape scanner), so the REAL
  // ControlServer's broadcast path emits them. pane.notify has no client-step
  // cause — it originates from the driver's %output scan — so the runner fires
  // it directly. Fired here (after any verb-driven pushes) because the current
  // transcript set never interleaves notifies with verb deltas.
  for (const s of serverSteps(t)) {
    if (s.message.type !== "pane.notify") continue;
    const m = s.message;
    pipeline.firePaneNotify(
      m.payload === undefined
        ? { paneId: m.paneId, kind: m.kind }
        : { paneId: m.paneId, kind: m.kind, payload: m.payload },
    );
    await Promise.resolve();
  }

  await new Promise((r) => setImmediate(r));

  // Assert the daemon's pushes match the transcript's session-proxy→client steps.
  assertDaemonPushes(t, pushed);
}

/**
 * Assert the daemon's actual pushes match the transcript's session-proxy→client
 * steps, in order, comparing message shape but IGNORING `seq` (per-connection,
 * daemon-assigned) and the snapshot's `attachedClientCount` (a runtime count).
 */
function assertDaemonPushes(t: Transcript, pushed: SessionProxyMessage[]): void {
  const expected = serverSteps(t)
    .filter((s) => s.message.type !== "session-proxy.capabilities")
    .map((s) => s.message);

  if (pushed.length !== expected.length) {
    fail(
      `daemon-side: expected ${expected.length} pushes but got ${pushed.length}\n` +
        `expected types: ${expected.map((m) => m.type).join(", ")}\n` +
        `actual   types: ${pushed.map((m) => m.type).join(", ")}`,
    );
  }

  for (let i = 0; i < expected.length; i++) {
    const expMsg = expected[i];
    const actMsg = pushed[i];
    if (expMsg === undefined || actMsg === undefined) {
      fail(`daemon-side: push #${i} index out of range (length invariant already checked)`);
    }
    assert.deepEqual(
      stripVolatile(actMsg),
      stripVolatile(expMsg),
      `daemon-side: push #${i} (${expMsg.type}) mismatch`,
    );
  }
}

/** Strip daemon-assigned/runtime fields that the transcript does not pin. */
function stripVolatile(msg: SessionProxyMessage): Record<string, unknown> {
  const { seq: _seq, ...rest } = msg as unknown as Record<string, unknown>;
  if (msg.type === "snapshot") {
    delete (rest as { attachedClientCount?: number }).attachedClientCount;
  }
  return rest;
}

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

/**
 * Run BOTH sides of conformance for a transcript: the SDK parser/mirror AND the
 * real session-proxy daemon. This is the single call a CI suite makes per
 * transcript to pin both ends of the protocol to the same wire material.
 */
export async function conformTranscript(t: Transcript): Promise<void> {
  await conformClientToTranscript(t);
  await conformDaemonToTranscript(t);
}

// Re-export the step types for runners that want to introspect.
export type { ServerStep, ClientStep };
export type { Transport };
