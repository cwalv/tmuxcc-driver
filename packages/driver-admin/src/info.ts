/**
 * info.ts — typed driver-introspection round-trips (tc-44u4.3).
 *
 * One reusable home for "connect to the EXISTING driver socket, run the
 * handshake, send a `*.info` command, correlate the response".  Before this,
 * the round-trip lived ONLY in tmuxcc-vscode (server-proxy-debug.ts) and any
 * non-VSCode consumer (the tc-44u4 investigation, ad-hoc diagnostics) had to
 * hand-roll connectSocketTransport + runClientHandshake + correlationId
 * matching.
 *
 * Two surfaces:
 *
 *   - {@link fetchServerProxyInfo}(socketName) → {@link ServerProxyInfoPayload}
 *       server-proxy wire: handshake `server-proxy.capabilities`, then a
 *       `command.request { command: { kind: "server-proxy.info" } }`.
 *       Payload carries `metricsText` (Prometheus text, server-proxy-level)
 *       plus the session roster + tmux/server-proxy pids.
 *
 *   - {@link fetchSessionProxyInfo}(socketName, sessionId) →
 *       {@link SessionProxyInfoPayload}
 *       session-proxy wire: claim the session-proxy endpoint off the server-proxy,
 *       connect to it via {@link SessionProxyConnection}, then a
 *       `command.request { command: { kind: "session-proxy.info" } }`.
 *       Payload carries `metricsText` (Prometheus text, per-session-proxy) plus
 *       the storm-alarm window gauges.
 *
 * # Security (epic-level constraint, tc-44u4)
 *
 * These functions connect to the EXISTING 0600 unix sockets via the EXISTING
 * handshake.  No new listener, no weaker auth, no broadened access — this is a
 * pure client-side connect/send/correlate surface.  The sockets carry sensitive
 * data (keystrokes incl. typed passwords + captured screen content); callers
 * must treat the payloads (esp. `metricsText`) as the operator's to read, never
 * to forward off-host without intent.
 *
 * # Shape note for tc-44u4.4 (HTTP exposition)
 *
 * Both functions return the FULL structured payload incl. raw `metricsText`; no
 * bespoke metric re-parsing happens here (callers that want Prometheus scrape
 * output forward `metricsText` verbatim).  A future
 * `server-proxy.set-metrics-http` toggle (tc-44u4.4) is a NEW server-proxy
 * command — it slots in as a sibling round-trip here (a `setServerProxyMetricsHttp`
 * that sends `{ kind: "server-proxy.set-metrics-http", … }` through the same
 * {@link runServerProxyCommand} helper).  This module is shaped so that is an
 * additive change, NOT a rewrite.  tc-44u4.3 does NOT implement the toggle.
 *
 * @module info
 */

import {
  serverProxySocketPath,
  connectSocketTransport,
} from "@tmuxcc/driver";
import { runClientHandshake, WIRE_PROTOCOL_VERSION, CommandError } from "@tmuxcc/protocol";
import type { Transport, MessageBase, Capabilities, ServerProxyCommand, ServerProxyCommandOkPayload, ServerProxyCommandResponseMessage, ServerProxyInfoPayload, SessionProxyInfoPayload, SessionProxyCommandResponseMessage } from "@tmuxcc/protocol";
import { SessionProxyConnection, markPreNegotiated } from "@tmuxcc/client";

// ---------------------------------------------------------------------------
// Capabilities advertised by the introspection client
// ---------------------------------------------------------------------------

/**
 * The minimal server-proxy-wire capabilities an introspection client needs:
 * it claims a session-proxy endpoint (`session-claim`) and reads diagnostics
 * (`server-proxy-info`).  The effective set is the intersection with the
 * server-proxy's advertised features; advertising more than we use is harmless
 * (the server-proxy ignores features it does not implement).
 */
const ADMIN_SERVER_PROXY_CAPS: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: ["server-proxy-info", "session-claim"],
};

// ---------------------------------------------------------------------------
// runServerProxyCommand — generic server-proxy request/response correlation
// ---------------------------------------------------------------------------

/**
 * Mint a fresh, collision-resistant correlationId for a single command.
 *
 * The id is opaque to the server-proxy (it only echoes it back); uniqueness
 * within this process is all that matters for matching the reply.
 */
function mintCorrelationId(): string {
  return `driver-admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Send one server-proxy command over a handshook transport and await the
 * correlated `command.response`.
 *
 * Shared by {@link fetchServerProxyInfo} and the session-proxy endpoint claim so
 * correlationId minting, error propagation, and transport-close rejection stay
 * in one place — the same de-dup the ext's `sendServerProxyCommand` provided,
 * now reusable outside VS Code.
 *
 * @throws if the server-proxy replies `ok: false`, or the transport closes
 *         before a response arrives.
 */
export async function runServerProxyCommand(
  transport: Transport,
  command: ServerProxyCommand,
  contextLabel: string,
): Promise<ServerProxyCommandOkPayload> {
  const correlationId = mintCorrelationId();

  const responsePromise = new Promise<ServerProxyCommandResponseMessage>(
    (resolve, reject) => {
      transport.onControl((msg: MessageBase) => {
        const m = msg as ServerProxyCommandResponseMessage;
        if (m.type === "command.response" && m.correlationId === correlationId) {
          resolve(m);
        }
      });
      transport.onClose((err) => {
        reject(
          err ??
            new Error(
              `server-proxy transport closed before ${contextLabel} response`,
            ),
        );
      });
    },
  );

  transport.sendControl({
    type: "command.request",
    seq: 1,
    correlationId,
    command,
  } as unknown as Parameters<typeof transport.sendControl>[0]);

  const response = await responsePromise;

  if (!response.result.ok) {
    const { code, message, details } = response.result;
    // tc-u4ny.3: rehydrate as CommandError so callers see typed code+details.
    throw new CommandError(code, `server-proxy ${contextLabel} failed: ${message}`, details);
  }

  return response.result.payload ?? {};
}

// ---------------------------------------------------------------------------
// fetchServerProxyInfo — one-shot server-proxy.info round-trip
// ---------------------------------------------------------------------------

/**
 * Connect to the server-proxy on `socketName`, send `server-proxy.info`, and
 * return the diagnostics payload.  The transport is closed before returning —
 * the server-proxy connection is request-scoped.
 *
 * @param socketName  The tmux/server-proxy socket name (server-proxy `-L` value;
 *                    also the runtime sub-dir name — they coincide by
 *                    construction, tc-5kv).
 *
 * @throws if:
 *   - the server-proxy socket does not exist / refuses connections (server-proxy
 *     not running) — callers may render that as "server-proxy not reachable",
 *     which is itself useful triage;
 *   - the handshake fails (version mismatch, timeout);
 *   - the server-proxy responds with an error (e.g. `protocol.unknown-message`
 *     from a pre-tc-k6v driver);
 *   - the response carries no `info` payload.
 */
export async function fetchServerProxyInfo(
  socketName: string,
): Promise<ServerProxyInfoPayload> {
  const endpoint = serverProxySocketPath(socketName);
  const transport = await connectSocketTransport(endpoint);

  let closed = false;
  transport.onClose(() => {
    closed = true;
  });

  try {
    await runClientHandshake(
      transport,
      ADMIN_SERVER_PROXY_CAPS,
      "server-proxy.capabilities",
    );
    const payload = await runServerProxyCommand(
      transport,
      { kind: "server-proxy.info" },
      "server-proxy.info",
    );
    if (payload.info === undefined) {
      throw new Error(
        "server-proxy.info succeeded but returned no info payload",
      );
    }
    return payload.info;
  } finally {
    if (!closed) {
      try {
        transport.close();
      } catch {
        /* already closed */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// fetchSessionProxyInfo — one-shot session-proxy.info round-trip
// ---------------------------------------------------------------------------

/**
 * Connect to the session-proxy backing the named session (via the server-proxy's
 * `session.claim`), send `session-proxy.info`, and return the per-session-proxy
 * diagnostics payload incl. `metricsText` (Prometheus text) and the storm-alarm
 * window gauges.
 *
 * Two request-scoped connections are made and torn down here: the server-proxy
 * socket (to resolve the session-proxy endpoint) and the session-proxy socket
 * itself.  Both are closed before returning.
 *
 * The endpoint is resolved via `session.claim`, the system's single
 * create-or-attach point (keyed by session NAME, not the numeric wire id — tmux
 * session numbers can be reshuffled).  For introspecting an EXISTING session
 * (the normal case) claim attaches with no side-effect; callers should pass the
 * `name` from a `server-proxy.info` session row, NOT a fabricated name, to avoid
 * minting an empty session.
 *
 * @param socketName   The tmux/server-proxy socket name (as for
 *                     {@link fetchServerProxyInfo}).
 * @param sessionName  The session NAME to introspect (the `name` field of a
 *                     `server-proxy.info` session row).
 *
 * @throws if the server-proxy/session-proxy is unreachable, either handshake
 *         fails, the claim is rejected, or the session-proxy responds with an
 *         error / no `info` payload (e.g. `protocol.unknown-message` from a
 *         pre-tc-x6l session-proxy).
 */
export async function fetchSessionProxyInfo(
  socketName: string,
  sessionName: string,
): Promise<SessionProxyInfoPayload> {
  // D5 (tc-4b6k.4): one connection to the single broker socket does the whole
  // round-trip — handshake, `session.claim` (resolve the sessionId), then
  // `session.attach` binds THIS connection to the session's stream. No second
  // socket, no endpoint.
  const brokerEndpoint = serverProxySocketPath(socketName);
  const transport = await connectSocketTransport(brokerEndpoint);
  let closed = false;
  transport.onClose(() => { closed = true; });

  // (1) One `server-proxy.capabilities` handshake — its NegotiatedSession is
  //     adopted by the SessionProxyConnection below (no second handshake).
  const negotiated = await runClientHandshake(
    transport,
    ADMIN_SERVER_PROXY_CAPS,
    "server-proxy.capabilities",
  );

  // (2) Claim the session by name to resolve its stable sessionId.
  const claim = await runServerProxyCommand(
    transport,
    { kind: "session.claim", name: sessionName },
    "session.claim",
  );
  if (claim.sessionId === undefined) {
    try { if (!closed) transport.close(); } catch { /* already closed */ }
    throw new Error("server-proxy session.claim succeeded but returned no sessionId");
  }

  // (3) Bind this connection to the session's stream, then run session-proxy.info
  //     over the pre-handshaken transport. session.attach is DEFERRED to
  //     onRoutingReady (fired by conn.connect() AFTER its router is installed) so
  //     the resulting snapshot lands on the live router, not the settle() no-op.
  const attachSessionId = claim.sessionId;
  markPreNegotiated(transport, negotiated, () => {
    transport.sendControl({
      type: "session.attach",
      seq: 1,
      sessionId: attachSessionId,
      // tc-51oo: driver-admin is a flagless, anonymous SDK reader that never
      // resizes. Attach with ignore-size so it is never a size candidate. Now
      // that ordinary VS Code windows attach flagless (they ARE the size drivers),
      // an unflagged admin connection to an ownerless session would transiently
      // become its size owner — harmless (it issues no resize) but wrong intent;
      // declaring ignore-size keeps size ownership exclusively with real windows.
      flags: { ignoreSize: true },
    } as unknown as Parameters<typeof transport.sendControl>[0]);
  });

  const conn = new SessionProxyConnection(transport);
  try {
    await conn.connect();
    return await sendSessionProxyInfo(conn);
  } finally {
    conn.close();
  }
}

/**
 * Send `session-proxy.info` over a ready {@link SessionProxyConnection} and await
 * the correlated `command.response`.
 *
 * The session-proxy wire correlates on `command.response.correlationId` exactly
 * like the server-proxy wire; we register a one-shot control handler and resolve
 * on the matching id.
 */
function sendSessionProxyInfo(
  conn: SessionProxyConnection,
): Promise<SessionProxyInfoPayload> {
  const correlationId = mintCorrelationId();

  return new Promise<SessionProxyInfoPayload>((resolve, reject) => {
    conn.onStateChange((state) => {
      if (state === "closed" || state === "failed") {
        reject(
          new Error(
            `session-proxy connection ${state} before session-proxy.info response`,
          ),
        );
      }
    });

    conn.onControl((msg) => {
      const m = msg as SessionProxyCommandResponseMessage;
      if (m.type !== "command.response" || m.correlationId !== correlationId) {
        return;
      }
      if (!m.result.ok) {
        // tc-u4ny.3: rehydrate as CommandError so callers see typed code+details.
        reject(new CommandError(
          m.result.code,
          `session-proxy.info failed: ${m.result.message}`,
          m.result.details,
        ));
        return;
      }
      const info = m.result.payload?.info;
      if (info === undefined) {
        reject(
          new Error(
            "session-proxy.info succeeded but returned no info payload",
          ),
        );
        return;
      }
      resolve(info);
    });

    conn.send({
      type: "command.request",
      seq: 1,
      correlationId,
      command: { kind: "session-proxy.info" },
    } as unknown as Parameters<typeof conn.send>[0]);
  });
}
