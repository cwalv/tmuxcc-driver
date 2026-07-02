/**
 * Two-client size-ownership behavioral test — tc-76m8.3 (S3 "Geometry among
 * peers"), real tmux 3.4.
 *
 * Proves the D4 POLICY layer end-to-end through the full session-proxy assembly
 * (`createSessionProxy` → `sessionProxy.addClient`, the path that carries the
 * activity/gate/reapply wiring — the fake-tmux harnesses attach via
 * `server.addClient` and bypass it). The debounce clock is injected so the
 * timing is deterministic; only the tmux resize round-trips use real time.
 *
 * The session-proxy holds ONE tmux `-CC` client; both VS Code peers are
 * driver-side clients multiplexed onto it. `resize.request → refresh-client -C`
 * sets that one client's size, so tmux's reported pane geometry is the ground
 * truth for which client's resize the gate let through.
 *
 * Coverage:
 *   T1. Alternation moves ownership after debounce (AC1) — a non-owner's resize
 *       is dropped; after the non-owner becomes the most-recently-active client
 *       and the debounce elapses, ownership moves and the new owner's viewport
 *       is re-applied (native-perfect geometry, no gesture).
 *   T2. Rapid interleaved input does not oscillate ownership (AC2) — the owner's
 *       own activity keeps cancelling the challenge, so ownership never flips
 *       during simultaneous typing.
 *   T3. Single-client D4 mechanics unchanged — the sole client drives size; a
 *       client that attached with the `ignore-size` flag never does.
 *
 * @module runtime/size-ownership.e2e.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  createInMemoryTransportPair,
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
} from "@tmuxcc/protocol";
import type { Transport, PaneId } from "@tmuxcc/protocol";

import { createSessionProxy } from "./session-proxy.js";
import type { SessionProxy } from "./session-proxy.js";
import type { Clock, TimeoutHandle } from "../state/coalescer.js";
import { trackSocket, killTmuxServer } from "./test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// tmux guard + socket bookkeeping (mirrors integration.test.ts conventions).
// ---------------------------------------------------------------------------

const tmuxAvailable = (() => {
  try {
    const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
    return r.status === 0 && /tmux\s+\d/.test(r.stdout ?? "");
  } catch {
    return false;
  }
})();

const RUN_SUFFIX = `${Date.now()}`;

function sockName(label: string): string {
  // tc-bpn shape: tmuxcc-test-<pid>-...; trackSocket BEFORE spawn so a thrown
  // test still gets its server reaped by the process-exit net.
  const sock = `tmuxcc-test-${process.pid}-so-${RUN_SUFFIX}-${label}`;
  trackSocket(sock);
  return sock;
}

const CLIENT_CAPS = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: [
    "pane-lifecycle" as const,
    "layout-updates" as const,
    "focus-events" as const,
    "input-forwarding" as const,
  ],
};

// ---------------------------------------------------------------------------
// Manual clock — the size-ownership debounce runs on this so `advance()` fires
// the reassignment timer deterministically. Other timers (pipeline, coalescer,
// storm alarm) keep their real clocks, so tmux round-trips run in real time.
// ---------------------------------------------------------------------------

interface ManualClock {
  clock: Clock;
  advance: (ms: number) => void;
}

function makeManualClock(): ManualClock {
  let now = 0;
  let nextId = 1;
  let timers: Array<{ id: number; fireAt: number; fn: () => void }> = [];
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fireAt: now + ms, fn });
      return id as unknown as TimeoutHandle;
    },
    clearTimeout: (h) => {
      timers = timers.filter((t) => t.id !== (h as unknown as number));
    },
  };
  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt)[0];
      if (next === undefined) break;
      now = next.fireAt;
      timers = timers.filter((t) => t.id !== next.id);
      next.fn();
    }
    now = target;
  }
  return { clock, advance };
}

// ---------------------------------------------------------------------------
// tmux geometry — the ground truth for which client's resize the gate allowed.
// ---------------------------------------------------------------------------

function queryTmuxSize(sock: string, session: string): { cols: number; rows: number } | null {
  const r = spawnSync(
    "tmux",
    ["-L", sock, "list-panes", "-t", session, "-F", "#{pane_width}x#{pane_height}"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  const line = (r.stdout ?? "").trim().split("\n")[0] ?? "";
  const m = /^(\d+)x(\d+)$/.exec(line);
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : null;
}

async function waitForSize(
  sock: string,
  session: string,
  cols: number,
  rows: number,
  timeoutMs: number,
  msg: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = queryTmuxSize(sock, session);
    if (s !== null && s.cols === cols && s.rows === rows) return;
    if (Date.now() > deadline) {
      throw new Error(`Timeout (${timeoutMs}ms): ${msg} (last=${JSON.stringify(s)})`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** Assert the geometry stays put for `windowMs` — a robust "resize was dropped"
 *  check (a resize that WAS issued would reach tmux within tens of ms). */
async function assertStaysSize(
  sock: string,
  session: string,
  cols: number,
  rows: number,
  windowMs: number,
  msg: string,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const s = queryTmuxSize(sock, session);
    assert.ok(
      s !== null && s.cols === cols && s.rows === rows,
      `${msg}: geometry became ${JSON.stringify(s)}, expected ${cols}x${rows}`,
    );
    await new Promise((r) => setTimeout(r, 40));
  }
}

// ---------------------------------------------------------------------------
// Harness — a real session-proxy plus per-client attach with a distinct D2
// identity (so the policy keys on identity, as in production).
// ---------------------------------------------------------------------------

interface Peer {
  ct: Transport;
  seq: number;
  resize(paneId: PaneId, cols: number, rows: number): void;
  input(paneId: PaneId): void;
  focus(): void;
}

async function attach(sessionProxy: SessionProxy, identityId: string): Promise<Peer> {
  const { sessionProxy: dt, client: ct } = createInMemoryTransportPair();
  const addP = sessionProxy.addClient(dt);
  await runClientHandshake(ct, CLIENT_CAPS, "session-proxy.capabilities", { id: identityId });
  await addP;
  const peer: Peer = {
    ct,
    seq: 1,
    resize(paneId, cols, rows) {
      ct.sendControl({ type: "resize.request", seq: ++peer.seq, paneId, cols, rows });
    },
    input(paneId) {
      ct.sendControl({ type: "input", seq: ++peer.seq, paneId, data: " " });
    },
    focus() {
      ct.sendControl({ type: "client.focus", seq: ++peer.seq });
    },
  };
  return peer;
}

function firstPaneId(sessionProxy: SessionProxy): PaneId {
  const it = sessionProxy.pipeline.getModel().panes.keys().next();
  assert.ok(!it.done, "session must have at least one pane after start");
  return it.value as PaneId;
}

const DEBOUNCE_MS = 250;

describe(
  "tc-76m8.3: size ownership follows activity (real tmux)",
  { skip: !tmuxAvailable ? "tmux not found on PATH" : false },
  () => {
    it(
      "T1: alternation moves ownership after debounce; the new owner's viewport is re-applied (AC1)",
      { timeout: 40_000 },
      async () => {
        const sock = sockName("alt");
        const session = "so-alt";
        after(() => killTmuxServer(sock));
        const { clock, advance } = makeManualClock();
        const sessionProxy = createSessionProxy({
          host: { socketName: sock, sessionName: session, cols: 80, rows: 24 },
          sizeOwnership: { debounceMs: DEBOUNCE_MS, clock },
        });
        sessionProxy.host.onError(() => {});
        await sessionProxy.start();

        try {
          const desk = await attach(sessionProxy, "deskA"); // first candidate → owner
          const laptop = await attach(sessionProxy, "lapB");
          const pid = firstPaneId(sessionProxy);

          // Owner (desk) resizes → tmux reflows to 200x50.
          desk.resize(pid, 200, 50);
          await waitForSize(sock, session, 200, 50, 15_000, "owner resize must reflow tmux");

          // Non-owner (laptop) resizes → dropped by the gate; geometry holds.
          laptop.resize(pid, 100, 30);
          await assertStaysSize(sock, session, 200, 50, 500, "non-owner resize must be dropped");

          // Control: the owner is still live and authoritative (rules out a dead
          // pipeline masquerading as a "drop").
          desk.resize(pid, 120, 36);
          await waitForSize(sock, session, 120, 36, 15_000, "owner remains authoritative");
          laptop.resize(pid, 100, 30); // laptop's latest desired viewport, still dropped
          await assertStaysSize(sock, session, 120, 36, 300, "non-owner resize still dropped");

          // Laptop becomes the most-recently-active client (typing). Ownership
          // does NOT move before the debounce elapses...
          laptop.input(pid);
          advance(DEBOUNCE_MS - 1);
          await assertStaysSize(sock, session, 120, 36, 300, "no premature ownership flip");

          // ...and DOES once the (now-idle) previous owner has been silent for the
          // full window: laptop owns, and its last viewport (100x30) is re-applied.
          advance(1);
          await waitForSize(
            sock,
            session,
            100,
            30,
            15_000,
            "after debounce, laptop owns and its viewport is re-applied",
          );

          // And it alternates back via focus (activity need not be typing).
          desk.focus();
          advance(DEBOUNCE_MS);
          desk.resize(pid, 90, 28);
          await waitForSize(sock, session, 90, 28, 15_000, "desk reclaims ownership after focus");
        } finally {
          sessionProxy.kill();
          killTmuxServer(sock);
        }
      },
    );

    it(
      "T2: rapid interleaved input does not oscillate ownership (AC2)",
      { timeout: 40_000 },
      async () => {
        const sock = sockName("thrash");
        const session = "so-thrash";
        after(() => killTmuxServer(sock));
        const { clock, advance } = makeManualClock();
        const sessionProxy = createSessionProxy({
          host: { socketName: sock, sessionName: session, cols: 80, rows: 24 },
          sizeOwnership: { debounceMs: DEBOUNCE_MS, clock },
        });
        sessionProxy.host.onError(() => {});
        await sessionProxy.start();

        try {
          const desk = await attach(sessionProxy, "deskA"); // owner
          const laptop = await attach(sessionProxy, "lapB");
          const pid = firstPaneId(sessionProxy);

          desk.resize(pid, 200, 50);
          await waitForSize(sock, session, 200, 50, 15_000, "owner establishes size");

          // Both peers type, interleaved, faster than the debounce. The owner's
          // activity keeps cancelling the challenge, so ownership never flips.
          for (let i = 0; i < 20; i++) {
            laptop.input(pid);
            advance(DEBOUNCE_MS / 4);
            desk.input(pid);
            advance(DEBOUNCE_MS / 4);
          }

          // Ownership never moved: laptop's resize is still dropped; desk's still
          // wins. (If it had oscillated, laptop would have driven size at least
          // once during the storm.)
          laptop.resize(pid, 100, 30);
          await assertStaysSize(sock, session, 200, 50, 500, "no oscillation: laptop never owned");
          desk.resize(pid, 160, 44);
          await waitForSize(sock, session, 160, 44, 15_000, "desk retained ownership throughout");
        } finally {
          sessionProxy.kill();
          killTmuxServer(sock);
        }
      },
    );

    it(
      "T3: single-client D4 mechanics unchanged (sole full client drives; sole ignore-size client does not)",
      { timeout: 40_000 },
      async () => {
        // Scenario A: a single full client is the sole candidate → owns → drives
        // size, exactly as before this policy layer existed.
        {
          const sock = sockName("solo-full");
          const session = "so-solo-full";
          after(() => killTmuxServer(sock));
          const { clock } = makeManualClock();
          const sessionProxy = createSessionProxy({
            host: { socketName: sock, sessionName: session, cols: 80, rows: 24 },
            sizeOwnership: { debounceMs: DEBOUNCE_MS, clock },
          });
          sessionProxy.host.onError(() => {});
          await sessionProxy.start();
          try {
            const solo = await attach(sessionProxy, "solo");
            const pid = firstPaneId(sessionProxy);
            solo.resize(pid, 200, 50);
            await waitForSize(sock, session, 200, 50, 15_000, "sole full client drives size");
          } finally {
            sessionProxy.kill();
            killTmuxServer(sock);
          }
        }

        // Scenario B: a single client attached with the tmux `ignore-size` flag
        // is never a size candidate — its resize is dropped even while it is the
        // only (and actively typing) client. Identical to the pre-policy D4 gate.
        {
          const sock = sockName("solo-passive");
          const session = "so-solo-passive";
          after(() => killTmuxServer(sock));
          const { clock } = makeManualClock();
          const sessionProxy = createSessionProxy({
            host: { socketName: sock, sessionName: session, cols: 80, rows: 24 },
            sizeOwnership: { debounceMs: DEBOUNCE_MS, clock },
          });
          sessionProxy.host.onError(() => {});
          await sessionProxy.start();
          try {
            const { sessionProxy: dt, client: ct } = createInMemoryTransportPair();
            const addP = sessionProxy.addClient(dt, { flags: { ignoreSize: true } });
            await runClientHandshake(ct, CLIENT_CAPS, "session-proxy.capabilities", { id: "passive" });
            await addP;
            const pid = firstPaneId(sessionProxy);
            ct.sendControl({ type: "input", seq: 2, paneId: pid, data: " " }); // activity...
            ct.sendControl({ type: "resize.request", seq: 3, paneId: pid, cols: 200, rows: 50 });
            // Geometry holds at the session's initial 80x24 — the ignore-size
            // client never drove `refresh-client -C` (D4 flag mechanics intact).
            await assertStaysSize(sock, session, 80, 24, 500, "ignore-size client never drives size");
          } finally {
            sessionProxy.kill();
            killTmuxServer(sock);
          }
        }
      },
    );
  },
);
