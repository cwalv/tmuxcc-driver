/**
 * stub-daemon.ts — a scriptable, in-memory stub session-proxy daemon for tests
 * (tc-ozk.4 / W3.2).
 *
 * This is the formalised successor to vscode's ad-hoc `stub-session-proxy.ts`.
 * It lives in the SDK package (`@tmuxcc/client`) so it is the SINGLE harness
 * every host test consumes — no parallel stub in the extension.
 *
 * # Two entry points
 *
 *   - `createStubSessionProxyTransport({ initialModel? })` — the lifecycle stub
 *     the vscode SessionManager tests rely on: completes the handshake and sends
 *     ONE snapshot (empty model by default, or `makeStubModel(...)` for the
 *     snapshot-replay path). Returns the CLIENT side of an in-memory transport,
 *     matching `() => Promise<Transport>` (SessionManager's ConnectFn).
 *
 *   - `runStubDaemon(transport, transcript)` — drives the session-proxy side of a
 *     transport through a full conformance transcript: handshake, snapshot,
 *     deltas, and verb responses (effect ids, origin, pane.capture). This is the
 *     scriptable daemon the conformance runner replays the SDK against, and that
 *     any future SDK (lua/python) runs against the same transcripts.
 *
 * # Fail-loud (epic policy)
 *
 * The stub daemon surfaces protocol violations LOUDLY: an unexpected client
 * message, or a `command.request` with no matching verb script, throws a named
 * `TranscriptError` rather than silently dropping it.
 *
 * # Why `setImmediate` / microtask deferral
 *
 * The deferral lets the client-side `onControl` handler (registered inside
 * `connectClient` AFTER `runClientHandshake` resolves) install before the daemon
 * sends `session-proxy.capabilities` / the snapshot. Without it the first push
 * races handler registration and is dropped onto the handshake's no-op handler.
 *
 * @module harness/stub-daemon
 */

import {
  createInMemoryTransportPair,
  runSessionProxyHandshake,
  WIRE_PROTOCOL_VERSION,
  projectSnapshot,
  emptyModel,
  addSession,
  addWindow,
  addPane,
  setFocus,
  paneId,
  windowId,
  sessionId,
} from "@tmuxcc/session-proxy";
import type {
  SessionModel,
  Transport,
  ControlMessage,
  SessionProxyCommandRequestMessage,
  SessionProxyCommandResponseMessage,
} from "@tmuxcc/session-proxy";

import { TranscriptError } from "./transcript.js";
import type { Transcript, ServerStep } from "./transcript.js";
import { serverSteps } from "./transcript.js";

// ===========================================================================
// makeStubModel — ergonomic fixture builder (ported verbatim from vscode)
// ===========================================================================

/** Options for {@link makeStubModel}. */
export interface StubModelOptions {
  /** Number of panes to add (all in s0/w0). Defaults to 1. The first is focused. */
  panes?: number;
  /** Columns for each pane. Defaults to 80. */
  cols?: number;
  /** Rows for each pane. Defaults to 24. */
  rows?: number;
}

/**
 * Build a minimal but non-empty `SessionModel` (1 session, 1 window, N panes,
 * first focused) — the canonical "real but minimal" fixture for exercising the
 * snapshot-replay code path.
 */
export function makeStubModel(opts: StubModelOptions = {}): SessionModel {
  const numPanes = opts.panes ?? 1;
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  const S0 = sessionId("s0");
  const W0 = windowId("w0");

  let model = emptyModel();
  model = addSession(model, {
    sessionId: S0,
    name: "stub",
    windowIds: [],
    activeWindowId: null,
  });
  model = addWindow(model, {
    windowId: W0,
    sessionId: S0,
    name: "stub",
    paneIds: [],
    activePaneId: null,
    synchronizePanes: false,
    monitorActivity: true,
    monitorSilence: 0,
    layout: {
      cols,
      rows,
      root: {
        kind: "pane",
        paneId: paneId("p0"),
        rect: { x: 0, y: 0, cols, rows },
      },
    },
  });

  for (let i = 0; i < numPanes; i++) {
    const P = paneId(`p${i}`);
    model = addPane(model, {
      paneId: P,
      windowId: W0,
      sessionId: S0,
      cols,
      rows,
      mode: "normal",
      dead: false,
      exitCode: undefined,
      label: undefined,
      // scrollbackHandle is optional — omit rather than passing undefined (exactOptionalPropertyTypes)
    });
  }

  const P0 = paneId("p0");
  model = setFocus(model, { paneId: P0, windowId: W0, sessionId: S0 });

  return model;
}

// ===========================================================================
// createStubSessionProxyTransport — lifecycle stub (vscode SessionManager tests)
// ===========================================================================

/** Options for {@link createStubSessionProxyTransport}. */
export interface StubSessionProxyOptions {
  /**
   * The initial model sent as the handshake snapshot. Omitted ⇒ an empty model
   * (the snapshot-replay code path is NOT exercised). Pass `makeStubModel(...)`
   * to exercise replay.
   */
  initialModel?: SessionModel;
}

/**
 * Create an in-memory transport that completes the session-proxy handshake and
 * sends the given (or empty) model as the initial snapshot. Returns the
 * CLIENT-side `Transport` (a `Promise<Transport>` matching ConnectFn).
 */
export function createStubSessionProxyTransport(
  opts: StubSessionProxyOptions = {},
): Promise<Transport> {
  const { sessionProxy: sessionProxyTransport, client: clientTransport } =
    createInMemoryTransportPair();

  setImmediate(() => {
    void (async () => {
      await runSessionProxyHandshake(sessionProxyTransport, {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        features: [] as string[],
      });
      const model = opts.initialModel ?? emptyModel();
      // Defer the snapshot by one microtask so the client's post-handshake
      // onControl handler is registered before it arrives.
      await Promise.resolve();
      sessionProxyTransport.sendControl(projectSnapshot(model));
    })();
  });

  return Promise.resolve(clientTransport);
}

// ===========================================================================
// runStubDaemon — scriptable transcript-driven daemon
// ===========================================================================

/** A handle on a running stub daemon. */
export interface StubDaemonHandle {
  /** Resolves once every session-proxy→client step in the transcript has been sent. */
  readonly donePushing: Promise<void>;
  /**
   * The client→session-proxy messages the daemon received, in arrival order.
   * Used by the conformance runner to assert the SDK emitted the transcript's
   * expected client messages.
   */
  readonly received: ClientMessageLog;
  /** Stop the daemon and detach its handlers (does NOT close the transport). */
  stop(): void;
}

/** Records inbound client→session-proxy messages for assertions. */
export interface ClientMessageLog {
  readonly messages: readonly ControlMessage[];
}

/**
 * Drive the session-proxy side of `transport` through `transcript`.
 *
 * Behaviour:
 *   1. Run the session-proxy handshake (sends `session-proxy.capabilities`,
 *      awaits `client.capabilities`).
 *   2. Replay the session-proxy→client steps in STRICT TRANSCRIPT ORDER (which
 *      is also strict seq order — the client mirror detects seq gaps and would
 *      resync if pushes arrived out of order). Each non-`command.response` step
 *      (snapshot, deltas) is sent immediately; a `command.response` step is
 *      GATED on the NEXT client `command.request` arriving first. Everything
 *      AFTER a gated response waits with it, so the verb's effect-id reply and
 *      its origin-tagged creation deltas land in the exact wire order the
 *      transcript pins.
 *   3. correlationId ECHO: the real client mints its OWN correlationId per
 *      `sendVerb` (the transcript's correlationId is just the daemon-side seed).
 *      The stub daemon matches command.requests to command.response steps BY
 *      ORDER and rewrites the outgoing response's correlationId to the client's
 *      actual one, so `sendVerb`'s pending-promise correlation resolves.
 *   4. A client `command.request` arriving when no command.response step remains
 *      is a hard failure (fail-loud).
 *
 * The pre-handshake control handler is replaced by the handshake; this installs
 * its own onControl AFTER the handshake settles.
 */
export function runStubDaemon(
  transport: Transport,
  transcript: Transcript,
): StubDaemonHandle {
  const received: ControlMessage[] = [];
  let stopped = false;

  // The ordered session-proxy→client steps to replay (drop the handshake
  // advertisement — the handshake already sent it).
  const steps: ServerStep[] = serverSteps(transcript).filter(
    (s) => s.message.type !== "session-proxy.capabilities",
  );
  const totalResponses = steps.filter((s) => s.message.type === "command.response").length;

  // FIFO queue of client correlationIds awaiting a scripted response, matched to
  // command.response steps in order. The Nth request pairs with the Nth response.
  const pendingRequestCorrelations: string[] = [];
  let responsesSent = 0;
  // Wakes the replay loop when it is blocked on the next request arriving.
  let wake: (() => void) | null = null;

  let resolveDone: () => void = () => {};
  const donePushing = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const installInboundHandler = (): void => {
    transport.onControl((msg: ControlMessage) => {
      if (stopped) return;
      received.push(msg);
      if (msg.type === "command.request") {
        const req = msg as SessionProxyCommandRequestMessage;
        if (responsesSent + pendingRequestCorrelations.length >= totalResponses) {
          throw new TranscriptError(
            `stub daemon received an unexpected command.request (correlationId "${req.correlationId}", ` +
              `kind="${req.command.kind}"): the transcript has only ${totalResponses} command.response step(s)`,
          );
        }
        pendingRequestCorrelations.push(req.correlationId);
        wake?.();
      }
      // input / resize.request / resync.request: recorded; the transcript
      // already encodes any resulting pushes as session-proxy→client steps.
    });
  };

  /** Resolve with the next client correlationId (FIFO), awaiting its arrival. */
  const nextRequestCorrelation = (): Promise<string | undefined> =>
    new Promise<string | undefined>((resolve) => {
      const check = (): void => {
        if (stopped) {
          wake = null;
          resolve(undefined);
        } else if (pendingRequestCorrelations.length > 0) {
          wake = null;
          resolve(pendingRequestCorrelations.shift());
        }
      };
      wake = check;
      check();
    });

  setImmediate(() => {
    void (async () => {
      await runSessionProxyHandshake(transport, {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding"],
      });
      // Install AFTER the handshake settles (it resets onControl to a no-op).
      installInboundHandler();
      // Defer one microtask so the client's onControl is in place.
      await Promise.resolve();
      for (const s of steps) {
        if (stopped) break;
        if (s.message.type === "command.response") {
          // Gate: wait for the next client request, then echo its correlationId.
          const correlationId = await nextRequestCorrelation();
          if (stopped || correlationId === undefined) break;
          responsesSent++;
          const reply: SessionProxyCommandResponseMessage = {
            ...(s.message as SessionProxyCommandResponseMessage),
            correlationId,
          };
          transport.sendControl(reply);
          continue;
        }
        transport.sendControl(s.message);
      }
      resolveDone();
    })();
  });

  return {
    donePushing,
    received: { messages: received },
    stop() {
      stopped = true;
      wake?.();
      transport.onControl(() => {});
    },
  };
}
