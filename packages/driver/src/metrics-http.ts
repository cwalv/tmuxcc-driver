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

import * as http from "node:http";

import { metricsHttpSocketPath, removeSocket, restrictSocket } from "./runtime-dir.js";
import type { RuntimeDirOptions } from "./runtime-dir.js";

/** Content-Type for Prometheus text exposition format v0.0.4. */
const PROM_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

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
export type MetricsHttpBind =
  | { readonly kind: "unix"; readonly path: string; readonly managed: boolean }
  | { readonly kind: "tcp"; readonly host: string; readonly port: number };

/** Loopback hosts permitted for a TCP bind (never world-reachable). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

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
export function parseMetricsHttpBind(
  spec: string | undefined,
  socketName: string,
  rtOpts: RuntimeDirOptions = {},
): MetricsHttpBind {
  const raw = (spec ?? "").trim();
  if (raw === "" || raw === "unix") {
    return { kind: "unix", path: metricsHttpSocketPath(socketName, rtOpts), managed: true };
  }
  if (raw.startsWith("unix:")) {
    const p = raw.slice("unix:".length);
    if (p.length === 0) {
      throw bindError(`empty unix socket path in "${raw}"`);
    }
    return { kind: "unix", path: p, managed: false };
  }

  // TCP: `host:port`.  Support bracketed IPv6 (`[::1]:port`) and bare
  // `host:port`.  Only loopback hosts are allowed — 127.0.0.1 is NOT per-user
  // isolated, so a non-loopback host would expose titles/metrics to the
  // network and is refused.
  let host: string;
  let portStr: string;
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0 || raw[close + 1] !== ":") {
      throw bindError(`malformed IPv6 bind "${raw}" (expected [host]:port)`);
    }
    host = raw.slice(1, close);
    portStr = raw.slice(close + 2);
  } else {
    const colon = raw.lastIndexOf(":");
    if (colon < 0) {
      throw bindError(`missing port in "${raw}" (expected host:port or unix:/path)`);
    }
    host = raw.slice(0, colon);
    portStr = raw.slice(colon + 1);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw bindError(
      `refusing non-loopback TCP bind host "${host}" — only 127.0.0.1 / ::1 / localhost are allowed ` +
        `(a TCP bind is single-user/trusted-host only; the secure default is a unix socket)`,
    );
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw bindError(`invalid port "${portStr}" in "${raw}"`);
  }
  // Normalise "localhost" to the v4 loopback for a deterministic bind.
  const boundHost = host === "localhost" ? "127.0.0.1" : host;
  return { kind: "tcp", host: boundHost, port };
}

function bindError(msg: string): Error {
  return Object.assign(new Error(`metrics.bind-invalid: ${msg}`), { code: "metrics.bind-invalid" });
}

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
export function bindMetricsHttp(
  bind: MetricsHttpBind,
  providers: MetricsHttpProviders,
): Promise<MetricsHttpListener> {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, providers);
  });

  // A metrics listener must never hold the event loop open on its own — the
  // server-proxy's control socket owns process lifetime (and the idle-exit
  // policy).  unref the underlying server so an enabled-but-unscraped metrics
  // surface cannot delay a self-exit.
  server.unref();

  return new Promise<MetricsHttpListener>((resolve, reject) => {
    const onError = (err: unknown): void => {
      server.removeListener("error", onError);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    server.once("error", onError);

    const onListening = (): void => {
      server.removeListener("error", onError);
      let address: string;
      if (bind.kind === "unix") {
        // Inherit the 0600 control-socket posture (reuse restrictSocket — no
        // hand-rolled chmod).  The 0700 runtime-dir chain already isolates the
        // parent; this locks the socket node itself.
        restrictSocket(bind.path);
        address = bind.path;
      } else {
        // Report the RESOLVED port (a `:0` request gets an OS-assigned
        // ephemeral port — callers/tests need the real number).
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : bind.port;
        address = `${bind.host}:${port}`;
      }
      resolve({
        address,
        close(): Promise<void> {
          return new Promise<void>((res) => {
            server.close(() => {
              // Remove the managed unix socket file so a re-enable doesn't
              // trip over a stale node (mirrors the control socket's
              // removeSocket-on-(re)bind discipline).
              if (bind.kind === "unix" && bind.managed) removeSocket(bind.path);
              res();
            });
            // close() only fires its callback once all connections drain;
            // unref keeps us from blocking shutdown on a hung scraper.
            server.unref();
          });
        },
      });
    };

    if (bind.kind === "unix") {
      // Clear any stale socket node from a crashed prior bind before listening
      // (mirrors server-proxy.sock's removeSocket-before-listen).
      removeSocket(bind.path);
      server.listen({ path: bind.path }, onListening);
    } else {
      server.listen({ host: bind.host, port: bind.port }, onListening);
    }
  });
}

/** Route + render one request. */
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  providers: MetricsHttpProviders,
): Promise<void> {
  // Strip any query string; we route on the path only.
  const url = req.url ?? "/";
  const pathOnly = url.split("?")[0] ?? "/";

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    res.end("405 Method Not Allowed\n");
    return;
  }

  try {
    if (pathOnly === "/metrics") {
      const body = await providers.metricsText();
      res.writeHead(200, { "Content-Type": PROM_CONTENT_TYPE });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (pathOnly === "/info") {
      const payload = await providers.infoJson();
      const body = JSON.stringify(payload);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found\n");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`500 Internal Server Error\n${msg}\n`);
  }
}

/** Re-export for callers that need the loopback-host predicate (tests). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}
