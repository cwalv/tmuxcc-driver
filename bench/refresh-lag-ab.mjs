// refresh-lag-ab.mjs — D6 / tc-4b6k.6 confirming intervention.
//
// Measures broker event-loop lag (nodejs_eventloop_lag, via
// perf_hooks.monitorEventLoopDelay — the same instrument prom-client's
// `nodejs_eventloop_lag_seconds` uses) while the broker's `_refreshSessions`
// is driven under a real-tmux `find /` firehose.
//
// The broker runs IN THIS PROCESS (tc-2x3.3 collapsed the session-proxies into
// the broker's loop), so monitorEventLoopDelay here measures exactly the loop
// that runs every session's delta pipeline. `server-proxy.info` is fired on a
// tight timer — each one calls `_refreshSessions` (the bead's "info" trigger) —
// so the south side is exercised under load.
//
// A/B: build the BASELINE (spawnSync south side) → run; build the CHANGE (async
// south side) → run; compare. Both runs are back-to-back on the same host with
// the same generator (internally controlled).
//
// Env knobs: BENCH_N (sessions, default 4), BENCH_DURATION_MS (default 15000),
// BENCH_INFO_INTERVAL_MS (default 20), BENCH_FIREHOSE (default 1).

import { monitorEventLoopDelay } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import {
  createServerProxy,
  connectSocketTransport,
  serverProxySocketPath,
} from "@tmuxcc/server-proxy";
import { runClientHandshake, WIRE_PROTOCOL_VERSION } from "@tmuxcc/session-proxy";
import { runServerProxyCommand } from "@tmuxcc/driver-admin";

const N = Number(process.env.BENCH_N ?? "4");
const DURATION_MS = Number(process.env.BENCH_DURATION_MS ?? "15000");
const INFO_INTERVAL_MS = Number(process.env.BENCH_INFO_INTERVAL_MS ?? "20");
const FIREHOSE = (process.env.BENCH_FIREHOSE ?? "1") !== "0";

const uniq = `${process.pid}-${Date.now()}`;
const socketName = `bench-lag-${uniq}`;
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), `tmuxcc-bench-${uniq}-`));

const CAPS = { protocolVersion: WIRE_PROTOCOL_VERSION, features: ["server-proxy-info", "session-claim"] };

function tmux(args) {
  return spawnSync("tmux", ["-L", socketName, ...args], { encoding: "utf8", timeout: 10_000 });
}

async function connectClient() {
  const endpoint = serverProxySocketPath(socketName, { runtimeDir });
  const transport = await connectSocketTransport(endpoint);
  await runClientHandshake(transport, CAPS, "server-proxy.capabilities");
  return transport;
}

function pct(sortedMs, p) {
  if (sortedMs.length === 0) return NaN;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

async function main() {
  const proxy = createServerProxy({ socketName, runtimeDir, persistThroughTmuxGone: true });
  await proxy.start();

  const client = await connectClient();

  // Claim N sessions — each spawns an in-process session-proxy `-CC attach`.
  const names = [];
  for (let i = 0; i < N; i++) {
    const name = `bench-s${i}`;
    names.push(name);
    await runServerProxyCommand(client, { kind: "session.claim", name }, "session.claim");
  }

  // Start a `find /` firehose in every session: raw %output flood on the shared
  // loop's session-proxy pipelines.
  if (FIREHOSE) {
    for (const name of names) {
      tmux(["send-keys", "-t", name, "find / 2>/dev/null", "Enter"]);
    }
    // Let the firehose ramp before measuring.
    await new Promise((r) => setTimeout(r, 2_000));
  }

  // Measure. Reset the histogram so warm-up/claim work is excluded.
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  h.reset();

  const infoLatenciesMs = [];
  let infoCount = 0;
  let infoErrors = 0;
  let stop = false;

  const driver = (async () => {
    while (!stop) {
      const t0 = performance.now();
      try {
        await runServerProxyCommand(client, { kind: "server-proxy.info" }, "server-proxy.info");
        infoLatenciesMs.push(performance.now() - t0);
        infoCount++;
      } catch {
        infoErrors++;
      }
      if (INFO_INTERVAL_MS > 0) await new Promise((r) => setTimeout(r, INFO_INTERVAL_MS));
    }
  })();

  await new Promise((r) => setTimeout(r, DURATION_MS));
  stop = true;
  await driver;
  h.disable();

  const infoSorted = infoLatenciesMs.slice().sort((a, b) => a - b);
  const ns2ms = (ns) => ns / 1e6;

  const result = {
    config: { N, DURATION_MS, INFO_INTERVAL_MS, FIREHOSE },
    eventloop_lag_ms: {
      mean: +ns2ms(h.mean).toFixed(3),
      p50: +ns2ms(h.percentile(50)).toFixed(3),
      p90: +ns2ms(h.percentile(90)).toFixed(3),
      p99: +ns2ms(h.percentile(99)).toFixed(3),
      max: +ns2ms(h.max).toFixed(3),
    },
    server_proxy_info_rtt_ms: {
      count: infoCount,
      errors: infoErrors,
      mean: infoSorted.length ? +(infoSorted.reduce((a, b) => a + b, 0) / infoSorted.length).toFixed(3) : NaN,
      p50: +pct(infoSorted, 50).toFixed(3),
      p99: +pct(infoSorted, 99).toFixed(3),
      max: +(infoSorted[infoSorted.length - 1] ?? NaN).toFixed(3),
    },
  };

  try { client.close(); } catch { /* ignore */ }
  await proxy.shutdown();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error("BENCH ERROR:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    try { tmux(["kill-server"]); } catch { /* ignore */ }
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
