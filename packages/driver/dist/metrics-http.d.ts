/**
 * In-process HTTP metrics exposition for the server-proxy (tc-44u4.4).
 *
 * Serves the Prometheus scrape surface so the tc-44u4 wedge signal
 * (`correlator_pending_slot_max_age_seconds` aging) can be continuously
 * monitored and alerted — the `*.info` wire commands only answer a one-shot
 * poll, never a scrape/alert loop.
 *
 * # Routes
 *
 *   - `GET /metrics` — Prometheus text exposition (the server-proxy registry
 *     merged with every live session registry; see `mergeMetricsText`).
 *   - `GET /info`    — the same JSON diagnostics payload as the
 *     `server-proxy.info` wire command (`ServerProxyInfoPayload`).
 *
 * Any other path / method → `404` / `405`.
 *
 * # Security posture (load-bearing — must match the 0600 control socket)
 *
 * `/info` carries session/window/pane TITLES and `/metrics` carries activity
 * metadata; both are sensitive and MUST NOT be world/other-readable.
 *
 *   - The secure DEFAULT bind is a UNIX-DOMAIN HTTP socket at
 *     `<runtime>/<socketName>/metrics-http.sock`, chmod 0600 under the
 *     existing 0700 XDG runtime-dir chain (`restrictSocket` /
 *     `metricsHttpSocketPath`, reused — no hand-rolled permission logic).  It
 *     inherits the per-user isolation of the control socket.
 *   - A loopback TCP bind (`127.0.0.1:<port>`) is permitted as a DOCUMENTED
 *     single-user / trusted-host tradeoff: `127.0.0.1` is NOT per-user
 *     isolated (any local process can connect).  A non-loopback host is
 *     REFUSED.  TCP is never the default.
 *
 * The listener is OFF until something binds it (startup flag/env, the
 * `server-proxy.set-metrics-http` wire toggle, or SIGUSR2).
 *
 * @module metrics-http
 */
import type { RuntimeDirOptions } from "./runtime-dir.js";
/**
 * A parsed metrics-HTTP bind target.
 *
 * - `kind: "unix"` — a unix-domain HTTP socket at `path`.  `managed` is true
 *   when `path` is the runtime-dir default (we own creation/removal and chmod
 *   it 0600); false for an explicit `unix:/...` path (still chmod'd 0600
 *   best-effort, but the caller chose the location).
 * - `kind: "tcp"`  — a loopback TCP listener on `host:port` (host is always a
 *   loopback address — a non-loopback host is rejected at parse time).
 */
export type MetricsHttpBind = {
    readonly kind: "unix";
    readonly path: string;
    readonly managed: boolean;
} | {
    readonly kind: "tcp";
    readonly host: string;
    readonly port: number;
};
/**
 * Parse a metrics-HTTP bind spec into a {@link MetricsHttpBind}.
 *
 * Accepted forms (mirrors the `--metrics-addr` / `TMUXCC_METRICS_ADDR`
 * vocabulary and the wire toggle's `bind` field):
 *
 *   - `undefined` / `""` / `"unix"` → the secure runtime-dir unix default.
 *   - `"unix:/abs/path.sock"`       → an explicit unix-domain HTTP socket.
 *   - `"127.0.0.1:9099"` / `"localhost:9099"` / `"[::1]:9099"` → loopback TCP.
 *
 * Throws `Error` (code `"metrics.bind-invalid"`) on a non-loopback TCP host,
 * a missing/invalid port, or an unparseable spec — the caller maps that to a
 * wire `result.ok = false` or refuses the startup flag.  Returning the
 * runtime-dir default for an empty spec keeps "enabled with no bind" meaning
 * "the secure default" everywhere (wire toggle, SIGUSR2, env).
 */
export declare function parseMetricsHttpBind(spec: string | undefined, socketName: string, rtOpts?: RuntimeDirOptions): MetricsHttpBind;
/** Data providers the HTTP surface renders. */
export interface MetricsHttpProviders {
    /** Render the merged Prometheus exposition (server-proxy + all sessions). */
    metricsText(): Promise<string>;
    /** Render the `/info` JSON payload (same shape as `server-proxy.info`). */
    infoJson(): Promise<unknown>;
}
/** A bound metrics-HTTP listener handle. */
export interface MetricsHttpListener {
    /** The bound address: an absolute unix socket path or `host:port`. */
    readonly address: string;
    /** Stop accepting connections and release the socket (idempotent). */
    close(): Promise<void>;
}
/**
 * Bind a metrics-HTTP listener at `bind`, serving `/metrics` and `/info` from
 * `providers`.  Resolves once the socket is listening (and, for a unix
 * socket, chmod'd 0600); rejects if the bind fails (`EADDRINUSE`, permission).
 *
 * The returned handle's `close()` unbinds the listener and, for a MANAGED
 * unix socket, removes the socket file — so a toggle-off leaves no stale
 * socket behind.
 */
export declare function bindMetricsHttp(bind: MetricsHttpBind, providers: MetricsHttpProviders): Promise<MetricsHttpListener>;
/** Re-export for callers that need the loopback-host predicate (tests). */
export declare function isLoopbackHost(host: string): boolean;
//# sourceMappingURL=metrics-http.d.ts.map