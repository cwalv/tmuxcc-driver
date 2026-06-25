#!/usr/bin/env node
/**
 * tmuxcc-info — ad-hoc driver-introspection CLI (tc-44u4.3).
 *
 * Thin shim over {@link fetchServerProxyInfo} / {@link fetchSessionProxyInfo}.
 * Node ergonomics, no bespoke metric re-parsing: it prints the FULL structured
 * payload as JSON and (unless `--json`) the raw `metricsText` Prometheus block
 * verbatim afterwards, so an operator gets both the typed fields and the scrape
 * text without this tool reimplementing a metrics parser.
 *
 * Usage:
 *   tmuxcc-info <socketName>                     # server-proxy.info
 *   tmuxcc-info <socketName> <sessionName>       # session-proxy.info
 *   tmuxcc-info <socketName> [sessionName] --json  # structured payload only
 *
 * Exit codes: 0 on success; 1 on any connect/handshake/command error (the
 * message — incl. "server-proxy not reachable" style failures — goes to stderr).
 *
 * Security: connects to the existing 0600 sockets via the existing handshake.
 * The output may contain sensitive runtime metrics — redirect/share with care.
 */
export {};
//# sourceMappingURL=tmuxcc-info.d.ts.map