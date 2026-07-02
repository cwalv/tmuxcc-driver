// ---------------------------------------------------------------------------
// Host-death instrument (tc-jlyi.17 — a-vs-c death-path discriminator)
//
// Dev-gated capture of WHICH path drove a session-proxy host death and the
// host's memory state at that instant.  Settles the one open question from
// tc-jlyi.13: the io-torture serial gating removed a high-N oversubscription
// trigger, but did NOT discriminate
//   (a) host-OOM from oversubscription            [INFRA — gating is correct]
//   (c) a product flood/teardown RACE under flood  [PRODUCT — gating masks a bug]
// A race would not show as tmux RSS growth, so tc-jlyi.13's RSS measurement
// (plateau ~6 MB, FC-bounded) cannot exclude (c).
//
// THE DISCRIMINATOR.  `onHostDeath` (session-proxy-supervisor.ts) fires from
// EITHER `host.onExit` OR `host.onError`:
//   - onExit  → the tmux `-CC attach` CLIENT process exited (code/signal).  If
//               the tmux SERVER was OOM-killed under it, the client exits →
//               combined with low MemAvailable / an OOM-kill of the tmux pid
//               this is INFRA (a).
//   - onError → the pty read-socket faulted IN THE PRODUCT under the flood
//               (tc-crnt.14 class, routed out of node-pty by tmux-host's
//               'error' listener).  With NO host memory pressure this is the
//               PRODUCT race (c).
//
// MID-FLOOD vs TEARDOWN (the tc-jlyi.16 confound).  A tmux-gone self-exit at a
// spec's after() is NORMAL/UNIVERSAL noise — NOT the io-torture failure.  The
// failure is a tmux death MID-FLOOD.  We disambiguate IN-BAND via `tornDown`,
// captured at record time:
//   - tornDown=true  → the death follows an INTENTIONAL reap (_teardownEntry /
//                      onFatalError sets tornDown BEFORE host.stop()) → the
//                      orderly end-of-spec path → expected noise.
//   - tornDown=false → a genuinely UNEXPECTED death while the session was live
//                      → the anomaly (mid-flood).
//
// Cost when unset: a single boolean check, no allocation, no clock read — this
// follows the TMUXCC_PHASE_TIMING / TMUXCC_WIRE_TRACE precedents.  When SET it
// reads /proc/meminfo + /proc/<pid>/status (cheap, synchronous) and, unless the
// server probe is disabled, runs ONE bounded `tmux -L <socket> display-message`
// spawnSync to read the tmux SERVER's liveness+RSS.  That spawnSync blocks the
// (collapsed, shared) event loop for up to its timeout — acceptable for an
// RCA run (dev-gated, off by default, and we are tearing this session down),
// but it is why the probe is opt-OUT-able via TMUXCC_DEATH_INSTRUMENT=noprobe.
//
// Lines land on stderr tagged `[tc-jlyi.17]`, auto-collected into
// <runtime>/<socket>/server-proxy.log by the existing stderr mirror.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Instrument mode, read once.
 *   ""        → disabled (zero cost).
 *   "noprobe" → enabled WITHOUT the tmux-server spawnSync probe (cheap /proc
 *               reads only; never perturbs the shared event loop).
 *   anything else (e.g. "1") → enabled WITH the bounded server probe.
 */
const DEATH_INSTRUMENT_MODE: string = process.env["TMUXCC_DEATH_INSTRUMENT"] ?? "";

/** True when the instrument is enabled (any non-empty value). Read once. */
export const DEATH_INSTRUMENT_ENABLED: boolean = DEATH_INSTRUMENT_MODE !== "";

/** True when the bounded tmux-server liveness/RSS probe should run. */
const DEATH_INSTRUMENT_PROBE: boolean =
  DEATH_INSTRUMENT_ENABLED && DEATH_INSTRUMENT_MODE !== "noprobe";

/** Which host event drove the death. */
export type DeathPath = "onExit" | "onError";

export interface HostDeathRecord {
  /** Which handler fired — the (a)-vs-(c) discriminator. */
  path: DeathPath;
  /** onExit: process exit code (may be null). */
  code?: number | null;
  /** onExit: terminating signal name (may be null). */
  signal?: string | null;
  /** onError: the fault routed out of node-pty (the tc-crnt.14 pty read fault). */
  error?: Error;
  /** Session identity for correlation with the failing spec. */
  sessionId: string;
  sessionName: string;
  /** tmux -L socket name, for the optional server-liveness probe. */
  socketName: string;
  /**
   * `entry.tornDown` AS OBSERVED at the death instant — the mid-flood (false)
   * vs orderly-teardown (true) discriminator.
   */
  tornDown: boolean;
}

/** Read a single `Key:   <n> kB` field from /proc/meminfo. -1 on miss/error. */
function meminfoKB(meminfo: string, key: string): number {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(meminfo);
  return m ? Number(m[1]) : -1;
}

/** Read VmRSS (kB) for a pid from /proc/<pid>/status. -1 if gone/unreadable. */
function rssKB(pid: number): number {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

interface ServerProbe {
  state: "alive" | "gone" | "unknown" | "skipped";
  pid: number;
  rssKB: number;
}

/**
 * Bounded `tmux -L <socket> display-message -p '#{pid}'` probe for the tmux
 * SERVER's liveness + RSS at the death instant.  Mirrors tmux-south's spawnSync
 * convention.  "no server running" → gone (decisive for an OOM-kill / infra
 * read); a live pid → alive (decisive for a product fault that did NOT take the
 * server with it).  Never throws.
 */
function probeTmuxServer(socketName: string): ServerProbe {
  if (!DEATH_INSTRUMENT_PROBE) return { state: "skipped", pid: -1, rssKB: -1 };
  try {
    const r = spawnSync(
      "tmux",
      ["-L", socketName, "display-message", "-p", "#{pid}"],
      { encoding: "utf8", timeout: 1_500 },
    );
    if (r.error) return { state: "unknown", pid: -1, rssKB: -1 };
    if (r.status === 0) {
      const pid = Number((r.stdout ?? "").trim());
      if (Number.isFinite(pid) && pid > 0) {
        return { state: "alive", pid, rssKB: rssKB(pid) };
      }
      return { state: "unknown", pid: -1, rssKB: -1 };
    }
    const stderr = (r.stderr ?? "").toLowerCase();
    if (stderr.includes("no server running") || stderr.includes("error connecting")) {
      return { state: "gone", pid: -1, rssKB: -1 };
    }
    return { state: "unknown", pid: -1, rssKB: -1 };
  } catch {
    return { state: "unknown", pid: -1, rssKB: -1 };
  }
}

/**
 * Record a host death.  No-op when the instrument is disabled.  Never throws —
 * instrumentation must not perturb the host (mirrors phaseLog / wireTrace).
 *
 * Emits ONE `[tc-jlyi.17] hostDeath ...` line with the discriminator path,
 * tornDown (mid-flood vs teardown), host memory at the instant, and the
 * tmux-server liveness/RSS probe; plus, for onError, a second
 * `[tc-jlyi.17] hostDeath-errstack ...` line carrying the fault stack (the
 * tc-crnt.14 pty read-socket-fault signature).
 */
export function recordHostDeath(rec: HostDeathRecord): void {
  if (!DEATH_INSTRUMENT_ENABLED) return;
  try {
    let meminfo = "";
    try {
      meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    } catch {
      /* non-Linux or unreadable — emit -1s */
    }
    const memAvailKB = meminfoKB(meminfo, "MemAvailable");
    const memFreeKB = meminfoKB(meminfo, "MemFree");
    const memTotalKB = meminfoKB(meminfo, "MemTotal");
    const swapFreeKB = meminfoKB(meminfo, "SwapFree");
    const swapTotalKB = meminfoKB(meminfo, "SwapTotal");

    const probe = probeTmuxServer(rec.socketName);

    const fields: Array<[string, string | number]> = [
      ["session", rec.sessionName],
      ["sessionId", rec.sessionId],
      ["path", rec.path],
      ["tornDown", String(rec.tornDown)],
      ["t", new Date().toISOString()],
    ];
    if (rec.path === "onExit") {
      fields.push(["code", rec.code ?? "null"]);
      fields.push(["signal", rec.signal ?? "null"]);
    } else {
      const e = rec.error;
      const errCode = (e as NodeJS.ErrnoException | undefined)?.code;
      fields.push(["errName", e?.name ?? "Error"]);
      fields.push(["errCode", errCode ?? "none"]);
      // keep the message on the single line, sanitized of newlines/spaces-as-sep
      fields.push(["errMsg", JSON.stringify(e?.message ?? String(e))]);
    }
    fields.push(["tmuxServer", probe.state]);
    fields.push(["tmuxServerPid", probe.pid]);
    fields.push(["tmuxServerRssKB", probe.rssKB]);
    fields.push(["memAvailKB", memAvailKB]);
    fields.push(["memFreeKB", memFreeKB]);
    fields.push(["memTotalKB", memTotalKB]);
    fields.push(["swapFreeKB", swapFreeKB]);
    fields.push(["swapTotalKB", swapTotalKB]);

    let line = "[tc-jlyi.17] hostDeath";
    for (const [k, v] of fields) line += ` ${k}=${v}`;
    process.stderr.write(`${line}\n`);

    if (rec.path === "onError" && rec.error?.stack) {
      const stack = rec.error.stack.replace(/\n/g, " | ");
      process.stderr.write(
        `[tc-jlyi.17] hostDeath-errstack session=${rec.sessionName} stack=${stack}\n`,
      );
    }
  } catch {
    /* instrumentation must never perturb the host */
  }
}
