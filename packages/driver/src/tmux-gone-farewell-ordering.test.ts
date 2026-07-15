/**
 * tmux-gone-farewell-ordering.test.ts — tc-j8mx.12
 *
 * The tmux-gone self-exit must not close client transports before the
 * in-process session-proxies' farewells are on the wire.
 *
 * # The race this pins
 *
 * On a no-persist whole-server death, two independent chains run in the ONE
 * broker process:
 *
 *   Chain A (per session): the session-proxy's `tmux -CC attach` pty exits →
 *   host.onExit → setImmediate (deferred so pending %output/%sessions-changed
 *   drain first — that defer is what makes cause:"pane-exit" attribution
 *   correct) → broadcastErrorAndClose(`session.unavailable`) — the farewell
 *   the extension's tc-76m8.38 latch keys its designed-death suppression on,
 *   in-band before the data-socket close.
 *
 *   Chain B (broker): watcher `-CC` pty EOF → probeTmuxLiveness → "gone" →
 *   _selfExit("tmux-gone") → shutdown() → transport.close() on EVERY
 *   transport, including the handed-off session data transports.
 *
 * Pre-fix, when Chain B won, the farewell was silently dropped (sendControl
 * no-ops on a closed transport) and clients saw a bare close — the extension
 * reacted with a spurious "connection lost." toast, and a lost pane-exit
 * attribution turned the S7-silent interactive exit into a spurious
 * "tmux server ended" toast (the two e2e leak flavors of tc-j8mx.12).
 *
 * # Determinism by construction
 *
 * The tests force the pre-fix-losing interleaving instead of racing it:
 * SIGSTOP the session's `-CC attach-session` client process, so Chain A
 * CANNOT run, then destroy the tmux server.  The watcher (a separate,
 * running process) EOFs, the probe confirms gone, and the broker enters
 * `_selfExit("tmux-gone")` with the farewell provably not yet sent — observed
 * via the `server-proxy.exiting` announcement on a C1 connection.  Only then
 * is the stopped client SIGCONTed, releasing Chain A.  With the tc-j8mx.12
 * drain the broker waits for the farewell FACT before closing transports, so
 * the data client must observe farewell-then-close; without it, shutdown has
 * already destroyed the transport by the time Chain A runs (the test then
 * fails deterministically, not 1-in-N).
 *
 * # Tests (both require tmux; Linux process control)
 *
 *   F1 (external whole-server teardown — the z-error-paths-killserver-no-persist
 *      flavor): the attached data client receives error{code:"session.unavailable",
 *      cause:"external"} BEFORE its transport close, and the broker still
 *      self-exits with reason "tmux-gone".
 *
 *   F2 (interactive last-pane exit — the the-last-pane flavor): same
 *      interleaving, but the death is headed by the pane's own shell exiting
 *      (`send-keys exit`).  The farewell must arrive before the close AND
 *      carry cause:"pane-exit" — the attribution the extension's gone-drain
 *      turns into S7 silence.  This proves the drain preserves the
 *      output-recency discriminator (the farewell still rides the
 *      session-proxy's own host-exit path; the broker only waits for it).
 *
 * @module tmux-gone-farewell-ordering.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createServerProxy, connectSocketTransport } from "./index.js";
import type { ServerProxySelfExitReason } from "./index.js";
import type { Transport } from "@tmuxcc/protocol";
import {
  runClientHandshake,
  WIRE_PROTOCOL_VERSION,
} from "@tmuxcc/protocol";
import type {
  ServerProxyCommandResponseMessage,
  MessageBase,
  Capabilities,
} from "@tmuxcc/protocol";
import { mintSocket } from "./runtime/test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// Helpers (mirrors session-removal-ordering.test.ts)
// ---------------------------------------------------------------------------

function tmuxAvailable(): boolean {
  const r = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
  return r.status === 0 && !r.error;
}

const TMUX_AVAILABLE = tmuxAvailable();

function makeRuntimeDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tmuxcc-test-fwo-${label}-`));
}

/** Poll `predicate` every `intervalMs` until truthy; throw on timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timeout (${timeoutMs}ms) waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function rejectAfter(ms: number, message: string): [Promise<never>, () => void] {
  let timer: ReturnType<typeof setTimeout>;
  const p = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (timer.unref) timer.unref();
  });
  return [p, () => clearTimeout(timer!)];
}

const CLIENT_CAPS: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: [
    "sessions-watch",
    "session-create",
    "session-destroy",
    "session-claim",
    "pane-attach",
  ],
};

/** Multiplexing wrapper around a Transport's single onControl slot. */
class TransportMux {
  private _transport: Transport;
  private _handlers: Array<(msg: MessageBase) => void> = [];

  constructor(transport: Transport) {
    this._transport = transport;
    this._transport.onControl((msg) => {
      const copy = this._handlers.slice();
      for (const h of copy) h(msg as unknown as MessageBase);
    });
  }

  subscribe(handler: (msg: MessageBase) => void): () => void {
    this._handlers.push(handler);
    return () => {
      this._handlers = this._handlers.filter((h) => h !== handler);
    };
  }

  get transport(): Transport {
    return this._transport;
  }
}

async function connectC1(endpoint: string): Promise<TransportMux> {
  const transport = await connectSocketTransport(endpoint);
  await runClientHandshake(transport, CLIENT_CAPS, "server-proxy.capabilities");
  return new TransportMux(transport);
}

async function sendCommand(
  mux: TransportMux,
  command: { kind: string; [k: string]: unknown },
  outgoingSeq: { value: number },
): Promise<ServerProxyCommandResponseMessage> {
  const correlationId = `corr-${Math.random().toString(36).slice(2)}`;
  const responsePromise = new Promise<ServerProxyCommandResponseMessage>((resolve) => {
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
  mux.transport.sendControl({
    type: "command.request",
    seq: outgoingSeq.value++,
    correlationId,
    command,
  } as unknown as Parameters<typeof mux.transport.sendControl>[0]);
  return responsePromise;
}

/**
 * D5 data connection: handshake on the broker socket, `session.attach`, wait
 * for the session-proxy snapshot.  Returns the mux (subscribe BEFORE acting).
 */
async function attachDataClient(endpoint: string, sessionId: string): Promise<TransportMux> {
  const transport = await connectSocketTransport(endpoint);
  await runClientHandshake(transport, CLIENT_CAPS, "server-proxy.capabilities");
  const mux = new TransportMux(transport);
  const snapshotPromise = new Promise<void>((resolve) => {
    const unsub = mux.subscribe((msg) => {
      if (msg.type === "snapshot") {
        unsub();
        resolve();
      }
    });
  });
  mux.transport.sendControl({
    type: "session.attach",
    seq: 1,
    sessionId,
  } as unknown as Parameters<typeof mux.transport.sendControl>[0]);
  const [timeoutP, clearTimeoutP] = rejectAfter(10_000, "Timeout waiting for session-proxy snapshot after session.attach");
  await Promise.race([snapshotPromise, timeoutP]);
  clearTimeoutP();
  return mux;
}

/**
 * PIDs of `tmux -CC attach-session` clients for a socket, split into the
 * SESSION-PROXY's host client and the broker's thin watcher — same pgrep
 * anchor, distinguished by the watcher's `-f no-output,ignore-size` cmdline
 * flags.
 */
function findAttachClientPids(socketName: string): { host: number | null; watcher: number | null } {
  const out: { host: number | null; watcher: number | null } = { host: null, watcher: null };
  const r = spawnSync("pgrep", ["-f", `^tmux -L ${socketName} -CC attach-session`], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (r.status !== 0 || r.error) return out;
  for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
    const pid = parseInt(line, 10);
    if (Number.isNaN(pid)) continue;
    let cmdline = "";
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue; // exited between pgrep and read
    }
    if (cmdline.includes("no-output")) out.watcher = pid;
    else out.host = pid;
  }
  return out;
}

/** True while `pid` exists (including stopped). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One event per wire-visible fact on the data connection, in observation
 * order — the ordering ledger the assertions read.
 */
interface FarewellLedger {
  events: string[];
  farewellIndex: () => number;
  closeIndex: () => number;
  farewellCause: () => string | undefined;
}

function recordDataConnection(mux: TransportMux): FarewellLedger {
  const events: string[] = [];
  let cause: string | undefined;
  mux.subscribe((msg) => {
    if (msg.type === "error") {
      const err = msg as unknown as { code?: string; cause?: string };
      if (err.code === "session.unavailable") {
        cause = err.cause;
        events.push("farewell");
      } else {
        events.push(`error:${err.code ?? "unknown"}`);
      }
    }
  });
  mux.transport.onClose(() => {
    events.push("close");
  });
  return {
    events,
    farewellIndex: () => events.indexOf("farewell"),
    closeIndex: () => events.indexOf("close"),
    farewellCause: () => cause,
  };
}

/**
 * Run one forced-interleaving teardown flavor and return the data-connection
 * ledger + the observed self-exit reasons.
 *
 * `die` destroys the tmux server AFTER the session host client has been
 * SIGSTOPped (Chain A frozen): F1 kills the server externally; F2 types
 * `exit` into the last pane so the pane's own death heads the cascade.
 *
 * `freezeWatcher` (F2): a last-pane death boots the watcher's client at
 * SESSION death, a beat before the server's exit-empty — an EOF probed in
 * that window reads "alive" and the broker respawns into a dead server
 * instead of self-exiting (a different, non-toast path).  Freezing the
 * watcher until the test has CONFIRMED the server is gone pins the probe to
 * the positive-"gone" verdict, i.e. to the designed-tmux-gone flow the e2e
 * leak rode.
 */
async function runForcedTeardown(
  label: string,
  die: (socketName: string, sessionName: string) => void,
  opts: { freezeWatcher?: boolean } = {},
): Promise<{ ledger: FarewellLedger; exits: ServerProxySelfExitReason[] }> {
  const socketName = mintSocket("fwo");
  const runtimeDir = makeRuntimeDir(label);
  const sessionName = `fwo-${label}`;
  const serverProxy = createServerProxy({ socketName, runtimeDir, idleExitMs: 600_000 });
  const exits: ServerProxySelfExitReason[] = [];
  serverProxy.onSelfExit((reason) => exits.push(reason));
  await serverProxy.start();

  let hostPid: number | null = null;
  let frozenWatcherPid: number | null = null;
  try {
    // C1 connection: claims the session and later observes the designed
    // `server-proxy.exiting` announcement (the "broker entered _selfExit"
    // cue this test keys the SIGCONT on).
    const c1 = await connectC1(serverProxy.endpoint());
    const seq = { value: 1 };
    const claim = await sendCommand(c1, { kind: "session.claim", name: sessionName }, seq);
    assert.ok(claim.result.ok, `session.claim failed: ${JSON.stringify(claim.result)}`);
    const { sessionId } = (claim.result as { ok: true; payload: { sessionId: string } }).payload;

    const exitingSeen = new Promise<void>((resolve) => {
      const unsub = c1.subscribe((msg) => {
        if (msg.type === "server-proxy.exiting") {
          unsub();
          resolve();
        }
      });
    });

    // Handed-off data connection — the transport the farewell must reach
    // before it closes.
    const data = await attachDataClient(serverProxy.endpoint(), sessionId);
    const ledger = recordDataConnection(data);

    // The broker's exit trigger is the WATCHER's EOF — it starts in pre-attach
    // poll mode (this broker was born with zero sessions) and only an ATTACHED
    // watcher EOFs on server death, so wait for it to attach before killing.
    await waitFor(
      () => findAttachClientPids(socketName).watcher !== null,
      10_000,
      "broker watcher -CC attach",
    );

    // Freeze Chain A: stop the session's -CC client so its pty cannot exit
    // (host.onExit cannot fire) until we say so.
    await waitFor(
      () => (hostPid = findAttachClientPids(socketName).host) !== null,
      10_000,
      "session-proxy -CC attach client pid",
    );
    process.kill(hostPid!, "SIGSTOP");

    if (opts.freezeWatcher === true) {
      frozenWatcherPid = findAttachClientPids(socketName).watcher;
      assert.ok(frozenWatcherPid !== null, "watcher pid vanished before freeze");
      process.kill(frozenWatcherPid, "SIGSTOP");
    }

    // Kill the tmux server with Chain A frozen.  The (running) watcher EOFs
    // and drives the broker's probe → "gone" → _selfExit("tmux-gone"); a
    // frozen watcher is released below once the server is confirmed gone.
    die(socketName, sessionName);

    if (frozenWatcherPid !== null) {
      // Confirm the server is positively gone BEFORE releasing the watcher,
      // so its EOF probes to the "gone" verdict (see freezeWatcher above).
      await waitFor(
        () => {
          const r = spawnSync("tmux", ["-L", socketName, "ls"], {
            encoding: "utf8",
            timeout: 3_000,
          });
          return r.status !== 0 && (r.stderr ?? "").includes("no server running");
        },
        15_000,
        `[${label}] tmux server death after the pane exit`,
        200,
      );
      process.kill(frozenWatcherPid, "SIGCONT");
    }

    // The designed-exit announcement proves the broker has entered _selfExit
    // — pre-fix it is already destroying the data transport here.  Release
    // Chain A only now.
    const [tp, ct] = rejectAfter(15_000, `[${label}] server-proxy.exiting never seen after tmux death`);
    await Promise.race([exitingSeen, tp]);
    ct();
    process.kill(hostPid!, "SIGCONT");

    // The broker must still complete its designed exit (the farewell drain
    // must not wedge it), and the data connection must have closed.
    await waitFor(() => exits.length > 0, 15_000, `[${label}] self-exit after tmux death`);
    assert.deepEqual(exits, ["tmux-gone"]);
    await waitFor(() => ledger.closeIndex() !== -1, 10_000, `[${label}] data transport close`);

    return { ledger, exits };
  } finally {
    if (hostPid !== null && pidAlive(hostPid)) {
      try { process.kill(hostPid, "SIGCONT"); } catch { /* already gone */ }
    }
    if (frozenWatcherPid !== null && pidAlive(frozenWatcherPid)) {
      try { process.kill(frozenWatcherPid, "SIGCONT"); } catch { /* already gone */ }
    }
    await serverProxy.shutdown();
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tc-j8mx.12: tmux-gone self-exit drains session farewells before closing transports (requires tmux)", { skip: !TMUX_AVAILABLE }, () => {
  it("F1: external whole-server teardown — farewell (cause external) reaches the data client BEFORE its transport close", { timeout: 60_000 }, async () => {
    const { ledger } = await runForcedTeardown("ext", (socketName) => {
      const r = spawnSync("tmux", ["-L", socketName, "kill-server"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(r.status, 0, `whole-server teardown failed: ${r.stderr}`);
    });

    assert.notEqual(
      ledger.farewellIndex(),
      -1,
      `the session.unavailable farewell must reach the data client on a designed ` +
        `whole-server death (got only: ${JSON.stringify(ledger.events)}) — a bare close ` +
        `is exactly the "connection lost." leak of tc-j8mx.12`,
    );
    assert.ok(
      ledger.farewellIndex() < ledger.closeIndex(),
      `farewell must precede the transport close (in-band designed-death ordering); ` +
        `observed: ${JSON.stringify(ledger.events)}`,
    );
    assert.equal(
      ledger.farewellCause(),
      "external",
      "an external whole-server death is unattributed — cause must be \"external\" " +
        "(the extension's gone-drain shows the ONE explanatory toast)",
    );
  });

  it("F2: interactive last-pane exit — farewell keeps cause \"pane-exit\" through the same interleaving (the S7-silence attribution)", { timeout: 60_000 }, async () => {
    const { ledger } = await runForcedTeardown(
      "lastpane",
      (socketName, sessionName) => {
        // The pane's own shell exit heads the death cascade: %output from the
        // echoed keystrokes lands just before %sessions-changed, which is the
        // output-recency discriminator the farewell's cause rides on.  The
        // session is the only one, so its death takes the whole tmux server
        // with it — same terminal state as F1, different head.
        const r = spawnSync(
          "tmux",
          ["-L", socketName, "send-keys", "-t", sessionName, "exit", "Enter"],
          { encoding: "utf8", timeout: 5_000 },
        );
        assert.equal(r.status, 0, `send-keys exit failed: ${r.stderr}`);
      },
      { freezeWatcher: true },
    );

    assert.notEqual(
      ledger.farewellIndex(),
      -1,
      `the session.unavailable farewell must reach the data client on an interactive ` +
        `last-pane exit (got only: ${JSON.stringify(ledger.events)}) — losing it leaks ` +
        `BOTH toasts (tc-j8mx.12 flavor 2)`,
    );
    assert.ok(
      ledger.farewellIndex() < ledger.closeIndex(),
      `farewell must precede the transport close; observed: ${JSON.stringify(ledger.events)}`,
    );
    assert.equal(
      ledger.farewellCause(),
      "pane-exit",
      "an interactive last-pane exit must keep its pane-exit attribution through the " +
        "farewell drain (S7: the extension silences the teardown on this cause) — " +
        "\"external\" here would leak a spurious \"tmux server ended\" toast",
    );
  });
});
