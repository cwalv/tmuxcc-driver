/**
 * collapsed-process-lifecycle.e2e.test.ts — tc-2x3.5
 *
 * # What this proves
 *
 * tc-2x3.3 collapsed the N session-proxy child processes INTO the server-proxy's
 * own event loop.  There is now ONE backend process (the server-proxy) that holds
 * ALL sessions in-process.  The old "daemon-crash-respawn" e2e tested a process
 * TREE (server-proxy + N session-proxy children) and exercised the READY-handshake
 * and die-with-parent machinery — both now deleted.
 *
 * This test is the collapsed-process EQUIVALENT:
 *
 *   Kill -9 the server-proxy process
 *   → tmux sessions SURVIVE (tmux server outlives the server-proxy)
 *   → relaunch a fresh server-proxy
 *   → it rediscovers the still-alive sessions and reattaches all bindings.
 *
 * # "Bindings restored" concrete definition
 *
 * After relaunch:
 *   1. The server-proxy's `sessions.snapshot` lists the session(s) that were
 *      alive in tmux (rediscovered via `_refreshSessions()` on start).
 *   2. `server-proxy.info` reports `adoptedExistingServer: true` — this flag
 *      is set when sessions are already present at start() time, proving the
 *      reattach path ran.
 *   3. `session.claim` on the still-alive session name succeeds and returns a
 *      live session-proxy endpoint (the in-process `ensureSessionProxy()` ran
 *      `_createSessionProxy()` → spawned a fresh `-CC attach` to the session).
 *   4. The returned endpoint is a live unix socket (probeLiveSocket → true).
 *
 * # Determinism
 *
 * Every wait uses `waitFor()` (poll every 50 ms, hard timeout), not
 * `setTimeout(fixed)`.  The kill/relaunch timing is deterministic because:
 *   - We wait for the server-proxy's unix socket to be unreachable (SIGKILL +
 *     socket-file removal race — the entry point does NOT clean up on SIGKILL,
 *     so we probe via connect() attempt that ECONNREFUSED/ENOENT = dead) before
 *     relaunching.  Actually: the entry script does NOT unlink the socket on
 *     SIGKILL, so we probe by trying to connect() — ECONNREFUSED/ENOENT.
 *     We poll until the socket file disappears OR a connect() fails
 *     (the latter happens first when the process is SIGKILLed because the
 *     OS closes all listening fds before unlinking any file).
 *   - The fresh launch is ready when "READY\n" arrives on its stdout.
 *   - All session assertions are gated on snapshot contents.
 *
 * # Requires real tmux
 *
 * Real tmux 3.4 is on PATH in this repo.  The suite skips cleanly when absent.
 *
 * @module collapsed-process-lifecycle.e2e.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connectSocketTransport, serverProxySocketPath, probeLiveSocket } from "./index.js";
import { runClientHandshake, WIRE_PROTOCOL_VERSION } from "@tmuxcc/session-proxy";
import type { Capabilities, ServerProxySnapshotMessage, ServerProxyCommandResponseMessage, MessageBase, ServerProxyInfoPayload } from "@tmuxcc/session-proxy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmuxAvailable(): boolean {
  const r = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
  return r.status === 0 && !r.error;
}

/** Poll `predicate()` every `intervalMs` until truthy or timeout. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const CLIENT_CAPS: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: ["sessions-watch", "session-create", "session-destroy", "session-claim", "pane-attach"],
};

/**
 * A minimal multiplexing wrapper — same pattern as server-proxy.test.ts.
 * Transport.onControl is replace-last-wins, so we fanout here.
 */
class TransportMux {
  private _handlers: Array<(msg: MessageBase) => void> = [];

  constructor(private readonly transport: ReturnType<typeof connectSocketTransport> extends Promise<infer T> ? T : never) {
    transport.onControl((msg) => {
      const copy = this._handlers.slice();
      for (const h of copy) h(msg as unknown as MessageBase);
    });
  }

  subscribe(handler: (msg: MessageBase) => void): () => void {
    this._handlers.push(handler);
    return () => { this._handlers = this._handlers.filter((h) => h !== handler); };
  }

  get raw() { return this.transport; }
}

/** Connect to a server-proxy socket, run the handshake, return mux + snapshot. */
async function connectAndHandshake(endpoint: string): Promise<{
  mux: TransportMux;
  snapshot: ServerProxySnapshotMessage;
}> {
  const transport = await connectSocketTransport(endpoint);
  await runClientHandshake(transport, CLIENT_CAPS, "server-proxy.capabilities");
  const mux = new TransportMux(transport);

  const snapshotP = new Promise<ServerProxySnapshotMessage>((resolve) => {
    const unsub = mux.subscribe((msg) => {
      if (msg.type === "sessions.snapshot") {
        unsub();
        resolve(msg as unknown as ServerProxySnapshotMessage);
      }
    });
  });

  const snapshot = await Promise.race([
    snapshotP,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout waiting for sessions.snapshot")), 5_000)
    ),
  ]);

  return { mux, snapshot };
}

/** Send a command and wait for the correlated response. */
async function sendCmd(
  mux: TransportMux,
  command: { kind: string; [k: string]: unknown },
  seq: { value: number },
): Promise<ServerProxyCommandResponseMessage> {
  const correlationId = `lc-${Math.random().toString(36).slice(2)}`;
  const responseP = new Promise<ServerProxyCommandResponseMessage>((resolve) => {
    const unsub = mux.subscribe((msg) => {
      if (
        msg.type === "command.response" &&
        (msg as unknown as ServerProxyCommandResponseMessage).correlationId === correlationId
      ) {
        unsub();
        resolve(msg as unknown as ServerProxyCommandResponseMessage);
      }
    });
  });

  mux.raw.sendControl({
    type: "command.request",
    seq: seq.value++,
    correlationId,
    command,
  } as unknown as Parameters<typeof mux.raw.sendControl>[0]);

  return Promise.race([
    responseP,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout waiting for response to ${command.kind}`)), 10_000)
    ),
  ]);
}

/**
 * Spawn the server-proxy entry script as a child process.
 * Returns the ChildProcess and a promise that resolves when "READY\n" is seen
 * on stdout (or rejects on timeout / early exit).
 */
function spawnServerProxy(opts: {
  socketName: string;
  runtimeDir: string;
  idleExitMs?: number;
  entryPath: string;
}): { child: ChildProcess; ready: Promise<void> } {
  const args = [
    "--import", "tsx",
    opts.entryPath,
    "--socket-name", opts.socketName,
    "--runtime-dir", opts.runtimeDir,
    "--idle-exit-ms", String(opts.idleExitMs ?? 60_000),
  ];

  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ready = new Promise<void>((resolve, reject) => {
    let buf = "";
    let settled = false;

    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      if (buf.includes("READY\n")) settle();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(new Error(`server-proxy exited early (code=${String(code)} signal=${String(signal)})`));
    };

    const timer = setTimeout(() => {
      settle(new Error("Timeout waiting for READY from server-proxy child"));
    }, 15_000);

    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });

  return { child, ready };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const TMUX_AVAILABLE = tmuxAvailable();

// Resolve the entry point path at module-load time (before tests run).
const ENTRY_PATH = fileURLToPath(
  new URL("./server-proxy-entry.ts", import.meta.url),
);

describe(
  "collapsed-process lifecycle e2e (tc-2x3.5, requires tmux)",
  { skip: !TMUX_AVAILABLE },
  () => {
    /**
     * LC1: kill -9 the server-proxy → tmux sessions survive → fresh
     *      server-proxy reattaches and restores all bindings.
     *
     * Proves the invariant stated in the bead description:
     *   "kill -9 the server-proxy → the tmux sessions survive (tmux server
     *    still running, sessions intact) → relaunch a fresh server-proxy →
     *    it rediscovers/reattaches those still-alive tmux sessions and all
     *    prior bindings are restored."
     */
    it(
      "LC1: kill -9 server-proxy → tmux sessions survive → relaunch reattaches all bindings",
      { timeout: 60_000 },
      async () => {
        const ts = Date.now();
        const socketName = `tmuxcc-e2e-lc-${process.pid}-${ts}`;
        const sessionName = `lc1-sess-${process.pid}`;
        const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), `tmuxcc-lc1-${process.pid}-`));

        let child1: ChildProcess | null = null;
        let child2: ChildProcess | null = null;

        try {
          // ── Phase 1: Spawn the first server-proxy ──────────────────────────────

          const launch1 = spawnServerProxy({
            socketName,
            runtimeDir,
            idleExitMs: 120_000, // long enough to survive the whole test
            entryPath: ENTRY_PATH,
          });
          child1 = launch1.child;

          await launch1.ready;

          const endpoint1 = serverProxySocketPath(socketName, { runtimeDir });

          // Verify the socket is live.
          assert.ok(
            await probeLiveSocket(endpoint1, 2_000),
            `server-proxy #1 socket must be live after READY; path: ${endpoint1}`,
          );

          // ── Phase 2: Connect + session.claim ──────────────────────────────────

          const { mux: mux1, snapshot: snap1 } = await connectAndHandshake(endpoint1);
          assert.equal(snap1.type, "sessions.snapshot");

          const seq1 = { value: 1 };
          const claimResp = await sendCmd(
            mux1,
            { kind: "session.claim", name: sessionName },
            seq1,
          );
          assert.ok(
            claimResp.result.ok,
            `session.claim (phase 1) must succeed; got: ${JSON.stringify(claimResp.result)}`,
          );
          const { sessionId: sessionId1, endpoint: sessEndpoint1 } = (
            claimResp.result as {
              ok: true;
              payload: { sessionId: string; endpoint: string; created: boolean };
            }
          ).payload;

          assert.ok(sessionId1, "session.claim must return a sessionId");
          assert.ok(sessEndpoint1, "session.claim must return a session-proxy endpoint");

          // Session-proxy socket must be live.
          assert.ok(
            await probeLiveSocket(sessEndpoint1, 3_000),
            `session-proxy endpoint must be live after claim; path: ${sessEndpoint1}`,
          );

          mux1.raw.close();

          // ── Phase 3: SIGKILL the server-proxy ─────────────────────────────────
          //
          // SIGKILL bypasses all cleanup: the server-proxy does NOT unlink its
          // socket file (the entry script only unlinks on SIGTERM / self-exit).
          // The OS closes listening fds immediately, so the socket file exists
          // on disk but is no longer accepting connections (ECONNREFUSED).
          // We poll probeLiveSocket until it returns false (dead socket).

          const pid1 = child1.pid;
          assert.ok(typeof pid1 === "number" && pid1 > 0, "child process must have a pid");

          process.kill(pid1, "SIGKILL");

          // Wait for the socket to stop accepting connections (process is dead).
          await waitFor(
            async () => !(await probeLiveSocket(endpoint1, 200)),
            8_000,
            "server-proxy #1 socket to stop accepting connections after SIGKILL",
          );

          child1 = null; // SIGKILL'd — won't get a normal exit event

          // ── Phase 4: Assert tmux sessions survived ────────────────────────────
          //
          // The tmux server and its sessions are INDEPENDENT of the server-proxy
          // process.  Even after SIGKILL, `tmux -L <sock> ls` must succeed.

          const tmuxLs = spawnSync(
            "tmux",
            ["-L", socketName, "ls"],
            { encoding: "utf8", timeout: 5_000 },
          );
          assert.equal(
            tmuxLs.status,
            0,
            `tmux ls must succeed after SIGKILL — tmux server must outlive the server-proxy; ` +
              `stderr: ${tmuxLs.stderr ?? ""}`,
          );
          assert.ok(
            tmuxLs.stdout.includes(sessionName),
            `tmux ls must still list '${sessionName}' after SIGKILL; got:\n${tmuxLs.stdout}`,
          );

          // ── Phase 5: Relaunch the fresh server-proxy ─────────────────────────
          //
          // The entry script calls removeSocket() on startup, so the stale
          // socket file (left by the SIGKILL'd process) is cleaned up atomically
          // before the new socket is bound.

          const launch2 = spawnServerProxy({
            socketName,
            runtimeDir,
            idleExitMs: 120_000,
            entryPath: ENTRY_PATH,
          });
          child2 = launch2.child;

          await launch2.ready;

          const endpoint2 = serverProxySocketPath(socketName, { runtimeDir });
          // Sanity: same well-known path.
          assert.equal(endpoint2, endpoint1, "relaunch must bind the same well-known socket path");

          assert.ok(
            await probeLiveSocket(endpoint2, 2_000),
            `server-proxy #2 socket must be live after READY`,
          );

          // ── Phase 6: Assert all bindings are restored ─────────────────────────

          // 6a. sessions.snapshot lists the surviving session.
          const { mux: mux2, snapshot: snap2 } = await connectAndHandshake(endpoint2);
          assert.equal(snap2.type, "sessions.snapshot");

          // The server-proxy must have rediscovered the session from tmux.
          // Snapshot is built from _refreshSessions() which runs at start().
          // Wait briefly for the snapshot to be accurate (it is in the first
          // connect — the refresh runs synchronously before the socket server
          // accepts connections, so the first snapshot is already correct).
          const sessionInSnapshot = snap2.sessions.find((s) => s.name === sessionName);
          assert.ok(
            sessionInSnapshot !== undefined,
            `sessions.snapshot must include '${sessionName}' after relaunch; ` +
              `got: ${JSON.stringify(snap2.sessions.map((s) => s.name))}`,
          );

          // 6b. server-proxy.info reports adoptedExistingServer=true (sessions
          //     were already alive in tmux when this server-proxy started — the
          //     canonical "reattach path was taken" signal).
          const seq2 = { value: 1 };
          const infoResp = await sendCmd(mux2, { kind: "server-proxy.info" }, seq2);
          assert.ok(
            infoResp.result.ok,
            `server-proxy.info must succeed; got: ${JSON.stringify(infoResp.result)}`,
          );
          const info = (
            infoResp.result as { ok: true; payload: { info: ServerProxyInfoPayload } }
          ).payload.info;

          assert.equal(
            info.adoptedExistingServer,
            true,
            `adoptedExistingServer must be true after relaunch with pre-existing tmux sessions ` +
              `(proves the reattach / rediscovery path ran)`,
          );

          // 6c. session.claim on the same session name succeeds and returns a
          //     live endpoint.  This exercises ensureSessionProxy() → the in-
          //     process _createSessionProxy() → fresh `-CC attach` to the tmux
          //     session that survived the SIGKILL.
          const claimResp2 = await sendCmd(
            mux2,
            { kind: "session.claim", name: sessionName },
            seq2,
          );
          assert.ok(
            claimResp2.result.ok,
            `session.claim (phase 6c) on relaunch must succeed; ` +
              `got: ${JSON.stringify(claimResp2.result)}`,
          );
          const { sessionId: sessionId2, endpoint: sessEndpoint2, created: created2 } = (
            claimResp2.result as {
              ok: true;
              payload: { sessionId: string; endpoint: string; created: boolean };
            }
          ).payload;

          assert.ok(sessionId2, "session.claim on relaunch must return a sessionId");
          assert.ok(sessEndpoint2, "session.claim on relaunch must return a session-proxy endpoint");
          // created=false: the tmux session already existed, the server-proxy attached.
          assert.equal(
            created2,
            false,
            `session.claim on relaunch must report created=false (session was pre-existing, ` +
              `not newly minted by this claim)`,
          );

          // 6d. The new session-proxy endpoint is a live unix socket.
          assert.ok(
            await probeLiveSocket(sessEndpoint2, 5_000),
            `reattached session-proxy endpoint must be live after relaunch; path: ${sessEndpoint2}`,
          );

          mux2.raw.close();
        } finally {
          // Clean up: kill both child processes if still running.
          if (child1 !== null) {
            try { child1.kill("SIGKILL"); } catch { /* already dead */ }
          }
          if (child2 !== null) {
            try { child2.kill("SIGTERM"); } catch { /* already dead */ }
            // Give SIGTERM a moment to let the server-proxy clean up.
            await new Promise((r) => setTimeout(r, 500));
            try { child2.kill("SIGKILL"); } catch { /* already dead */ }
          }
          // Kill the tmux server for this test socket.
          spawnSync("tmux", ["-L", socketName, "kill-server"], {
            stdio: "ignore",
            timeout: 5_000,
          });
          // Remove runtime dir.
          try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      },
    );

    /**
     * LC2: kill -9 server-proxy with MULTIPLE claimed sessions → ALL survive
     *      in tmux → relaunch rediscovers and reattaches ALL of them.
     *
     * Exercises the "all sessions" part of the bead's acceptance criterion.
     */
    it(
      "LC2: kill -9 with 2 sessions → both survive in tmux → relaunch reattaches both",
      { timeout: 90_000 },
      async () => {
        const ts = Date.now();
        const socketName = `tmuxcc-e2e-lc2-${process.pid}-${ts}`;
        const sessionNameA = `lc2-sess-a-${process.pid}`;
        const sessionNameB = `lc2-sess-b-${process.pid}`;
        const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), `tmuxcc-lc2-${process.pid}-`));

        let child1: ChildProcess | null = null;
        let child2: ChildProcess | null = null;

        try {
          // ── Phase 1: Spawn the first server-proxy + claim 2 sessions ──────────

          const launch1 = spawnServerProxy({
            socketName,
            runtimeDir,
            idleExitMs: 120_000,
            entryPath: ENTRY_PATH,
          });
          child1 = launch1.child;
          await launch1.ready;

          const endpoint1 = serverProxySocketPath(socketName, { runtimeDir });
          assert.ok(await probeLiveSocket(endpoint1, 2_000), "server-proxy #1 must be live");

          const { mux: mux1 } = await connectAndHandshake(endpoint1);
          const seq1 = { value: 1 };

          const claimA = await sendCmd(mux1, { kind: "session.claim", name: sessionNameA }, seq1);
          assert.ok(claimA.result.ok, `claim A failed: ${JSON.stringify(claimA.result)}`);

          const claimB = await sendCmd(mux1, { kind: "session.claim", name: sessionNameB }, seq1);
          assert.ok(claimB.result.ok, `claim B failed: ${JSON.stringify(claimB.result)}`);

          mux1.raw.close();

          // ── Phase 2: SIGKILL ──────────────────────────────────────────────────

          const pid1 = child1.pid!;
          process.kill(pid1, "SIGKILL");
          child1 = null;

          await waitFor(
            async () => !(await probeLiveSocket(endpoint1, 200)),
            8_000,
            "server-proxy #1 dead after SIGKILL",
          );

          // ── Phase 3: Both tmux sessions must still be alive ───────────────────

          const lsResult = spawnSync("tmux", ["-L", socketName, "ls"], {
            encoding: "utf8",
            timeout: 5_000,
          });
          assert.equal(
            lsResult.status,
            0,
            `tmux ls must succeed after SIGKILL; stderr: ${lsResult.stderr ?? ""}`,
          );
          assert.ok(
            lsResult.stdout.includes(sessionNameA),
            `tmux ls must list '${sessionNameA}'; got:\n${lsResult.stdout}`,
          );
          assert.ok(
            lsResult.stdout.includes(sessionNameB),
            `tmux ls must list '${sessionNameB}'; got:\n${lsResult.stdout}`,
          );

          // ── Phase 4: Relaunch ─────────────────────────────────────────────────

          const launch2 = spawnServerProxy({
            socketName,
            runtimeDir,
            idleExitMs: 120_000,
            entryPath: ENTRY_PATH,
          });
          child2 = launch2.child;
          await launch2.ready;

          const endpoint2 = serverProxySocketPath(socketName, { runtimeDir });
          assert.ok(await probeLiveSocket(endpoint2, 2_000), "server-proxy #2 must be live");

          // ── Phase 5: Both sessions in snapshot; reattach both ─────────────────

          const { mux: mux2, snapshot: snap2 } = await connectAndHandshake(endpoint2);
          const names2 = snap2.sessions.map((s) => s.name);

          assert.ok(
            names2.includes(sessionNameA),
            `snapshot must include '${sessionNameA}' after relaunch; got: ${JSON.stringify(names2)}`,
          );
          assert.ok(
            names2.includes(sessionNameB),
            `snapshot must include '${sessionNameB}' after relaunch; got: ${JSON.stringify(names2)}`,
          );

          const seq2 = { value: 1 };

          // server-proxy.info must report adoptedExistingServer=true.
          const infoResp2 = await sendCmd(mux2, { kind: "server-proxy.info" }, seq2);
          assert.ok(infoResp2.result.ok, `server-proxy.info failed: ${JSON.stringify(infoResp2.result)}`);
          const info2 = (
            infoResp2.result as { ok: true; payload: { info: ServerProxyInfoPayload } }
          ).payload.info;
          assert.equal(
            info2.adoptedExistingServer,
            true,
            "adoptedExistingServer must be true after relaunch with 2 pre-existing sessions",
          );

          // session.claim for both sessions must succeed with created=false.
          const claimA2 = await sendCmd(mux2, { kind: "session.claim", name: sessionNameA }, seq2);
          assert.ok(claimA2.result.ok, `claim A on relaunch failed: ${JSON.stringify(claimA2.result)}`);
          const payloadA2 = (claimA2.result as {
            ok: true;
            payload: { endpoint: string; created: boolean };
          }).payload;
          assert.equal(payloadA2.created, false, "session A on relaunch: created must be false");
          assert.ok(
            await probeLiveSocket(payloadA2.endpoint, 5_000),
            `session A reattached endpoint must be live; path: ${payloadA2.endpoint}`,
          );

          const claimB2 = await sendCmd(mux2, { kind: "session.claim", name: sessionNameB }, seq2);
          assert.ok(claimB2.result.ok, `claim B on relaunch failed: ${JSON.stringify(claimB2.result)}`);
          const payloadB2 = (claimB2.result as {
            ok: true;
            payload: { endpoint: string; created: boolean };
          }).payload;
          assert.equal(payloadB2.created, false, "session B on relaunch: created must be false");
          assert.ok(
            await probeLiveSocket(payloadB2.endpoint, 5_000),
            `session B reattached endpoint must be live; path: ${payloadB2.endpoint}`,
          );

          mux2.raw.close();
        } finally {
          if (child1 !== null) {
            try { child1.kill("SIGKILL"); } catch { /* already dead */ }
          }
          if (child2 !== null) {
            try { child2.kill("SIGTERM"); } catch { /* already dead */ }
            await new Promise((r) => setTimeout(r, 500));
            try { child2.kill("SIGKILL"); } catch { /* already dead */ }
          }
          spawnSync("tmux", ["-L", socketName, "kill-server"], {
            stdio: "ignore",
            timeout: 5_000,
          });
          try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      },
    );
  },
);
