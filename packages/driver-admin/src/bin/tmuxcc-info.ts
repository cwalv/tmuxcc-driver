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

import {
  fetchServerProxyInfo,
  fetchSessionProxyInfo,
} from "../info.js";

interface ParsedArgs {
  readonly socketName: string;
  readonly sessionName: string | undefined;
  readonly jsonOnly: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let jsonOnly = false;
  for (const arg of argv) {
    if (arg === "--json") {
      jsonOnly = true;
    } else if (arg === "-h" || arg === "--help") {
      printUsageAndExit(0);
    } else if (arg.startsWith("-")) {
      process.stderr.write(`tmuxcc-info: unknown flag "${arg}"\n`);
      printUsageAndExit(1);
    } else {
      positional.push(arg);
    }
  }
  const socketName = positional[0];
  if (socketName === undefined) {
    printUsageAndExit(1);
  }
  return { socketName, sessionName: positional[1], jsonOnly };
}

function printUsageAndExit(code: number): never {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write(
    [
      "Usage:",
      "  tmuxcc-info <socketName>                  server-proxy.info",
      "  tmuxcc-info <socketName> <sessionName>    session-proxy.info",
      "",
      "Flags:",
      "  --json   print the structured payload only (omit raw metricsText block)",
      "",
    ].join("\n"),
  );
  process.exit(code);
}

/**
 * Emit a payload: the structured fields as pretty JSON, then (unless `--json`)
 * the raw `metricsText` verbatim under a fenced header.  `metricsText` stays in
 * the JSON too — splitting it out is a convenience, not a removal.
 */
function emit(
  payload: { readonly metricsText: string | null },
  jsonOnly: boolean,
): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  if (jsonOnly) return;
  const metrics = payload.metricsText;
  process.stdout.write("\n# --- metricsText (Prometheus exposition) ---\n");
  process.stdout.write(metrics === null ? "(none)\n" : metrics + "\n");
}

async function main(): Promise<void> {
  const { socketName, sessionName, jsonOnly } = parseArgs(process.argv.slice(2));
  const payload =
    sessionName === undefined
      ? await fetchServerProxyInfo(socketName)
      : await fetchSessionProxyInfo(socketName, sessionName);
  emit(payload, jsonOnly);
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`tmuxcc-info: ${detail}\n`);
  process.exit(1);
});
