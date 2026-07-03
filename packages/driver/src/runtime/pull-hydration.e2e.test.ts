/**
 * tc-76m8.28: `ClientFlags.pullHydration` — the addClient-time unsolicited
 * replay is suppressed for clients that hydrate by explicit `pane.attach`.
 *
 * Real tmux, full session-proxy assembly (`createSessionProxy` →
 * `sessionProxy.addClient`, the path that reads `opts.flags` — the fake-tmux
 * harnesses attach via `server.addClient` and bypass it).
 *
 * Why the flag exists (the geometry-changed-blip corruption, found by
 * tc-76m8.24): the addClient-time push captures tmux's grid BEFORE the client
 * has converged tmux to its tabs' geometry. A client that gates its own
 * `pane.attach` replay on settled geometry (the extension's resize-then-
 * restore gate) must therefore receive NO unsolicited replay — on a reconnect
 * whose geometry changed during the blip, the pushed stale-geometry grid
 * lands history rows in-viewport on the open recycled tab, where the managed
 * resize's SIGWINCH redraw destroys them. The driver cannot know "settled"
 * (managed authority is client-defined), so the gate is the CLIENT's; the
 * driver's part is to keep this entry point closed for clients that declare
 * they pull.
 *
 * Coverage:
 *   T1. pullHydration client: NO unsolicited hydration after attach (no
 *       pane.hydration.begin, no clear+replay frame); a subsequent explicit
 *       `pane.attach` on the SAME connection still hydrates (begin →
 *       clear+replay → end) — the pull path is the one entry point and it
 *       works.
 *   T2. Flag-less client: the tc-5quo bulk push is UNCHANGED (unsolicited
 *       begin + clear+replay arrive) — the suppression is flag-scoped, not a
 *       behavior change for clients that never send `pane.attach`.
 *   T3. pullHydration + primaryPaneId (targeted attach): the targeted-primary
 *       push is suppressed too — BOTH unsolicited forms are closed.
 *
 * The replay-frame detector keys on the CLEAR_AND_SCROLLBACK prefix
 * (`ESC[H ESC[2J ESC[3J`) that every hydration frame starts with — an idle
 * shell pane emits no such sequence on its own.
 *
 * @module runtime/pull-hydration.e2e.test
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
import { CLEAR_AND_SCROLLBACK } from "./hydration.js";
import { trackSocket, killTmuxServer } from "./test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// tmux guard + socket bookkeeping (mirrors size-ownership.e2e.test.ts).
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
  const sock = `tmuxcc-test-${process.pid}-ph-${RUN_SUFFIX}-${label}`;
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
// Recording attach — control + data recorders installed BEFORE addClient
// resolves, so the addClient-time hydration (emitted before addClient
// returns) cannot slip past them. No await between the handshake resolving
// and the recorder install (same synchronous continuation).
// ---------------------------------------------------------------------------

interface RecordingClient {
  ct: Transport;
  seq: number;
  /** Control message types received, in order (snapshot, hydration sentinels, …). */
  control: string[];
  /** Data frames received (paneId + bytes), in order. */
  data: Array<{ paneId: PaneId; bytes: Uint8Array }>;
}

async function attachRecording(
  sessionProxy: SessionProxy,
  identityId: string,
  opts?: Parameters<SessionProxy["addClient"]>[1],
): Promise<RecordingClient> {
  const { sessionProxy: dt, client: ct } = createInMemoryTransportPair();
  const rec: RecordingClient = { ct, seq: 1, control: [], data: [] };
  const addP = sessionProxy.addClient(dt, opts);
  await runClientHandshake(ct, CLIENT_CAPS, "session-proxy.capabilities", { id: identityId });
  ct.onControl((msg) => rec.control.push((msg as { type: string }).type));
  ct.onData((pid, bytes) => rec.data.push({ paneId: pid, bytes }));
  await addP;
  return rec;
}

/** Does `bytes` start with the hydration clear escape (ESC[H ESC[2J ESC[3J)? */
function isReplayFrame(bytes: Uint8Array): boolean {
  if (bytes.length < CLEAR_AND_SCROLLBACK.length) return false;
  for (let i = 0; i < CLEAR_AND_SCROLLBACK.length; i++) {
    if (bytes[i] !== CLEAR_AND_SCROLLBACK[i]) return false;
  }
  return true;
}

function hydrationBegins(rec: RecordingClient): number {
  return rec.control.filter((t) => t === "pane.hydration.begin").length;
}

function replayFrames(rec: RecordingClient): number {
  return rec.data.filter((d) => isReplayFrame(d.bytes)).length;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll until `cond()` or fail with `msg` after `timeoutMs`. */
async function waitUntil(cond: () => boolean, timeoutMs: number, msg: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timeout (${timeoutMs}ms): ${msg}`);
    await sleep(25);
  }
}

/**
 * The unsolicited push, when it happens, STARTS synchronously inside
 * addClient (the begin sentinel is emitted before addClient returns), so
 * "no begin after addClient resolved + a couple of tmux RTTs" is a sound
 * negative. This window bounds the wait, it does not time the push.
 */
const NO_PUSH_WINDOW_MS = 500;

function firstPaneId(sessionProxy: SessionProxy): PaneId {
  const it = sessionProxy.pipeline.getModel().panes.keys().next();
  assert.ok(!it.done, "session must have at least one pane after start");
  return it.value as PaneId;
}

describe(
  "tc-76m8.28: pullHydration suppresses the addClient-time unsolicited replay (real tmux)",
  { skip: !tmuxAvailable ? "tmux not found on PATH" : false },
  () => {
    it(
      "T1: pullHydration client gets NO unsolicited replay; explicit pane.attach still hydrates",
      { timeout: 40_000 },
      async () => {
        const sock = sockName("pull");
        after(() => killTmuxServer(sock));
        const sessionProxy = createSessionProxy({
          host: { socketName: sock, sessionName: "ph-pull", cols: 80, rows: 24 },
        });
        sessionProxy.host.onError(() => {});
        await sessionProxy.start();

        try {
          const rec = await attachRecording(sessionProxy, "puller", {
            flags: { pullHydration: true },
          });
          const pid = firstPaneId(sessionProxy);

          // Negative: nothing unsolicited.
          await sleep(NO_PUSH_WINDOW_MS);
          assert.strictEqual(
            hydrationBegins(rec),
            0,
            `unsolicited hydration pushed to a pullHydration client (control=${JSON.stringify(rec.control)})`,
          );
          assert.strictEqual(replayFrames(rec), 0, "unsolicited clear+replay frame delivered");

          // Positive: the pull path is intact on the SAME connection.
          rec.ct.sendControl({ type: "pane.attach", seq: ++rec.seq, paneId: pid });
          await waitUntil(
            () =>
              hydrationBegins(rec) === 1 &&
              replayFrames(rec) === 1 &&
              rec.control.includes("pane.hydration.end"),
            15_000,
            "explicit pane.attach must hydrate (begin → clear+replay → end)",
          );
          assert.ok(
            !rec.control.includes("pane.attach.failed"),
            "pane.attach for a live pane must not fail",
          );
        } finally {
          sessionProxy.kill();
          killTmuxServer(sock);
        }
      },
    );

    it(
      "T2: flag-less client keeps the tc-5quo bulk push (control)",
      { timeout: 40_000 },
      async () => {
        const sock = sockName("push");
        after(() => killTmuxServer(sock));
        const sessionProxy = createSessionProxy({
          host: { socketName: sock, sessionName: "ph-push", cols: 80, rows: 24 },
        });
        sessionProxy.host.onError(() => {});
        await sessionProxy.start();

        try {
          const rec = await attachRecording(sessionProxy, "pusher");
          await waitUntil(
            () => hydrationBegins(rec) >= 1 && replayFrames(rec) >= 1,
            15_000,
            "flag-less client must receive the unsolicited bulk replay",
          );
        } finally {
          sessionProxy.kill();
          killTmuxServer(sock);
        }
      },
    );

    it(
      "T3: pullHydration suppresses the targeted-primary push too",
      { timeout: 40_000 },
      async () => {
        const sock = sockName("targ");
        after(() => killTmuxServer(sock));
        const sessionProxy = createSessionProxy({
          host: { socketName: sock, sessionName: "ph-targ", cols: 80, rows: 24 },
        });
        sessionProxy.host.onError(() => {});
        await sessionProxy.start();

        try {
          const pid = firstPaneId(sessionProxy);
          const rec = await attachRecording(sessionProxy, "puller-targeted", {
            primaryPaneId: pid,
            flags: { pullHydration: true },
          });

          await sleep(NO_PUSH_WINDOW_MS);
          assert.strictEqual(
            hydrationBegins(rec),
            0,
            `targeted-primary hydration pushed to a pullHydration client (control=${JSON.stringify(rec.control)})`,
          );
          assert.strictEqual(replayFrames(rec), 0, "unsolicited clear+replay frame delivered");
          // The primary's pane.not-found validation moves to the client's own
          // pane.attach — no unsolicited failure either.
          assert.ok(
            !rec.control.includes("pane.attach.failed"),
            "no unsolicited pane.attach.failed for a live primary",
          );
        } finally {
          sessionProxy.kill();
          killTmuxServer(sock);
        }
      },
    );
  },
);
