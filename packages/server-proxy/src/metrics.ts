/**
 * Server-proxy metrics registry (tc-x6l).
 *
 * Thin prom-client registry for the server-proxy process itself — tracks
 * server-level counters that the session-proxy registry doesn't own:
 *
 *   - `server_proxy_commands_total{kind}` — server-proxy wire commands received
 *     (session.claim, session.create, session.destroy, server-proxy.info, …).
 *   - `server_proxy_connections_total` — total IPC connections accepted
 *     (raw socket-level, pre-handshake).
 *   - `server_proxy_connections_active` — current open connection count
 *     (gauge — incremented on connect, decremented on close).
 *   - `server_proxy_sessions_active` — current session count (gauge).
 *
 * This module is intentionally small. Per-session topology metrics live in the
 * per-session `SessionProxyRegistry` (packages/session-proxy/src/metrics/).
 *
 * # Debug surface (tc-x6l)
 *
 * `ServerProxyMetrics.metricsText()` returns the Prometheus text exposition
 * for this registry. It is included in the `server-proxy.info` response payload
 * under `ServerProxyInfoPayload.metricsText`.
 *
 * @module server-proxy/metrics
 */

import { Registry, Counter, Gauge } from "prom-client";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Server-proxy-level metrics handle (tc-x6l). */
export interface ServerProxyMetrics {
  /**
   * Increment the command counter for the given command kind.
   * @param kind - The `ServerProxyCommand.kind` value (e.g. "session.claim").
   */
  incCommand(kind: string): void;

  /** Increment the total connections accepted counter. */
  incConnectionAccepted(): void;

  /** Increment the active connection gauge (on connect). */
  incConnectionActive(): void;

  /** Decrement the active connection gauge (on close). */
  decConnectionActive(): void;

  /** Set the active sessions gauge (replaces the previous value). */
  setSessionsActive(count: number): void;

  /**
   * Return the Prometheus text exposition for this registry.
   * Returns a Promise<string> to match prom-client's async API.
   */
  metricsText(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the server-proxy metrics registry.
 *
 * One instance per server-proxy process. Kept in the ServerProxyImpl and
 * included in `server-proxy.info` responses.
 */
export function createServerProxyMetrics(): ServerProxyMetrics {
  const reg = new Registry();

  const commandsTotal = new Counter({
    name: "server_proxy_commands_total",
    help: "Total server-proxy wire commands received, by command kind.",
    labelNames: ["kind"],
    registers: [reg],
  });

  const connectionsTotal = new Counter({
    name: "server_proxy_connections_total",
    help: "Total IPC connections accepted (raw socket-level, pre-handshake).",
    registers: [reg],
  });

  const connectionsActive = new Gauge({
    name: "server_proxy_connections_active",
    help: "Current number of open IPC connections.",
    registers: [reg],
  });

  const sessionsActive = new Gauge({
    name: "server_proxy_sessions_active",
    help: "Current number of sessions in the server-proxy session table.",
    registers: [reg],
  });

  return {
    incCommand(kind: string): void {
      commandsTotal.inc({ kind });
    },

    incConnectionAccepted(): void {
      connectionsTotal.inc();
    },

    incConnectionActive(): void {
      connectionsActive.inc();
    },

    decConnectionActive(): void {
      connectionsActive.dec();
    },

    setSessionsActive(count: number): void {
      sessionsActive.set(count);
    },

    async metricsText(): Promise<string> {
      return reg.metrics();
    },
  };
}
