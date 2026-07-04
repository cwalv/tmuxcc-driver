/**
 * apply-at-create.test.ts — real-tmux behavioral coverage for the tc-gjdx.3
 * template compiler + apply-at-create transaction.
 *
 * These are the AC's behavioral guarantees, and they are all REAL-TMUX:
 *   T1. Apply-at-create produces the expected topology + geometry + cwd + env,
 *       sets @tmuxcc-template, and surfaces it on the session row.
 *   T2. Exactly-once under racing claims (the broker serialises per name — only
 *       the created:true claimant applies).
 *   T3. No apply on reattach / re-claim (apply is gated on created:true).
 *   T4. Mid-transaction failure surfaces a loud error naming the failed verb +
 *       created-so-far state, with NO rollback (the partial session persists).
 *   T5. The tc-128 coalescer absorbs a many-window apply burst: the model
 *       converges with no refuted-confirmation tripwire.
 *
 * Harness: each test spins up its own broker on a unique `-L` socket + private
 * runtime dir, tmux-guarded, and issues real `tmux` queries for ground truth.
 * Runs in the serialized real-tmux lane (--test-concurrency=1).
 *
 * @module apply-at-create.test
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createServerProxy, connectSocketTransport } from "./index.js";
import type { ServerProxyHandle } from "./index.js";
import { runClientHandshake, WIRE_PROTOCOL_VERSION } from "@tmuxcc/protocol";
import type {
  Transport,
  Capabilities,
  MessageBase,
  ServerProxySnapshotMessage,
  ServerProxyCommandResponseMessage,
  SnapshotMessage,
  SessionTemplate,
} from "@tmuxcc/protocol";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let counter = 0;
function nextSocketName(): string {
  return `tmuxcc-test-gjdx3-${process.pid}-${++counter}-${Date.now()}`;
}

function tmuxAvailable(): boolean {
  const r = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
  return r.status === 0 && !r.error;
}

/** Run a synchronous `tmux -L <socket> …` query and return trimmed stdout. */
function tmuxQ(socket: string, args: string[]): string {
  const r = spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 5_000 });
  return (r.stdout ?? "").trim();
}

function killServer(socket: string): void {
  spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 5_000 });
}

function makeRuntimeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-gjdx3-rt-"));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timeout (${timeoutMs}ms) waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const CLIENT_CAPS: Capabilities = {
  protocolVersion: WIRE_PROTOCOL_VERSION,
  features: ["sessions-watch", "session-create", "session-claim", "session-destroy"],
};

/** Fan-out wrapper over Transport's single onControl slot. */
class Mux {
  private _handlers: Array<(m: MessageBase) => void> = [];
  constructor(readonly transport: Transport) {
    transport.onControl((m) => {
      for (const h of this._handlers.slice()) h(m as unknown as MessageBase);
    });
  }
  subscribe(h: (m: MessageBase) => void): () => void {
    this._handlers.push(h);
    return () => {
      this._handlers = this._handlers.filter((x) => x !== h);
    };
  }
}

async function connectCommand(
  endpoint: string,
): Promise<{ mux: Mux; snapshot: ServerProxySnapshotMessage }> {
  const transport = await connectSocketTransport(endpoint);
  await runClientHandshake(transport, CLIENT_CAPS, "server-proxy.capabilities");
  const mux = new Mux(transport);
  const snapshot = await new Promise<ServerProxySnapshotMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("snapshot timeout")), 5_000);
    const unsub = mux.subscribe((m) => {
      if (m.type === "sessions.snapshot") {
        clearTimeout(timer);
        unsub();
        resolve(m as unknown as ServerProxySnapshotMessage);
      }
    });
  });
  return { mux, snapshot };
}

let outSeq = 1;
function sendCommand(
  mux: Mux,
  command: Record<string, unknown>,
): Promise<ServerProxyCommandResponseMessage> {
  const correlationId = `c-${Math.random().toString(36).slice(2)}`;
  const p = new Promise<ServerProxyCommandResponseMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`command ${String(command.kind)} timeout`)), 20_000);
    const unsub = mux.subscribe((m) => {
      if (
        m.type === "command.response" &&
        (m as unknown as ServerProxyCommandResponseMessage).correlationId === correlationId
      ) {
        clearTimeout(timer);
        unsub();
        resolve(m as unknown as ServerProxyCommandResponseMessage);
      }
    });
  });
  mux.transport.sendControl({
    type: "command.request",
    seq: outSeq++,
    correlationId,
    command,
  } as unknown as Parameters<typeof mux.transport.sendControl>[0]);
  return p;
}

/**
 * Attach ONE data connection to a session and await the session-proxy model
 * converging to `expectedWindows` windows and `expectedPanes` panes.
 *
 * The requery pipeline converges asynchronously after the apply burst; we track
 * convergence on a SINGLE connection via the snapshot + the topology delta
 * stream (window.added / window.closed / pane.opened / pane.closed) rather than
 * re-attaching (rapid re-attach churn stalls the session.attach handshake).
 * Returns the converged connection's mux (kept open for a follow-up
 * session-proxy.info read).
 */
async function attachAwaitTopology(
  endpoint: string,
  sessionId: string,
  expectedWindows: number,
  expectedPanes: number,
  timeoutMs: number,
): Promise<Mux> {
  const transport = await connectSocketTransport(endpoint);
  await runClientHandshake(transport, CLIENT_CAPS, "server-proxy.capabilities");
  const mux = new Mux(transport);

  const windows = new Set<string>();
  const panes = new Set<string>();
  let settled = false;

  const converged = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `session-proxy model did not converge to ${expectedWindows}w/${expectedPanes}p ` +
            `within ${timeoutMs}ms (last: ${windows.size}w/${panes.size}p)`,
        ),
      );
    }, timeoutMs);
    const check = (): void => {
      if (!settled && windows.size === expectedWindows && panes.size === expectedPanes) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    mux.subscribe((m) => {
      switch (m.type) {
        case "snapshot": {
          const s = m as unknown as SnapshotMessage;
          for (const w of s.windows) windows.add(w.windowId);
          for (const p of s.panes) panes.add(p.paneId);
          break;
        }
        case "window.added":
          windows.add((m as unknown as { windowId: string }).windowId);
          break;
        case "window.closed":
          windows.delete((m as unknown as { windowId: string }).windowId);
          break;
        case "pane.opened":
          panes.add((m as unknown as { paneId: string }).paneId);
          break;
        case "pane.closed":
          panes.delete((m as unknown as { paneId: string }).paneId);
          break;
      }
      check();
    });
  });

  mux.transport.sendControl({
    type: "session.attach",
    seq: 1,
    sessionId,
  } as unknown as Parameters<typeof mux.transport.sendControl>[0]);

  await converged;
  return mux;
}

interface OkPayload {
  sessionId?: string;
  created?: boolean;
  name?: string;
}
function okPayload(resp: ServerProxyCommandResponseMessage): OkPayload {
  assert.ok(resp.result.ok, `expected ok, got ${JSON.stringify(resp.result)}`);
  return (resp.result as { ok: true; payload: OkPayload }).payload;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("apply-at-create (tc-gjdx.3, real tmux)", () => {
  let haveTmux = false;
  before(() => {
    haveTmux = tmuxAvailable();
  });

  it("T1: topology + geometry + cwd + env + @tmuxcc-template awareness + session-row surfacing", async (t) => {
    if (!haveTmux) return t.skip("tmux not available");
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-gjdx3-cwd-"));
    const sp = createServerProxy({ socketName, runtimeDir });
    await sp.start();
    try {
      const { mux } = await connectCommand(sp.endpoint());

      // Pane A writes its cwd + the injected env var to files so we can verify
      // -c and -e reached the pane; then sleeps to stay alive for inspection.
      const writeCmd =
        `pwd > ${dirA}/cwd.txt; printf %s "$TCENV" > ${dirA}/env.txt; sleep 300`;
      const template: SessionTemplate = {
        name: "devtmpl",
        windows: [
          {
            name: "editor",
            geometry: {
              kind: "vsplit",
              children: [
                { kind: "pane", cwd: dirA, command: writeCmd, env: { TCENV: "gjdx3-marker" } },
                { kind: "pane" },
              ],
            },
          },
          { name: "logs" },
        ],
      };

      const resp = await sendCommand(mux, { kind: "session.create", name: "t1", template });
      const payload = okPayload(resp);
      assert.equal(payload.created, true, "session.create mints, so created:true");

      // -- ground truth via tmux --------------------------------------------
      // Windows: exactly the two template windows; the throwaway initial window
      // was killed (create-all-fresh-then-kill-initial).
      const winLines = tmuxQ(socketName, ["list-windows", "-t", "t1", "-F", "#{window_id} #{window_name}"])
        .split("\n")
        .filter(Boolean);
      const winNames = winLines.map((l) => l.split(" ")[1]).sort();
      assert.deepEqual(winNames, ["editor", "logs"], `windows = ${winLines.join(" | ")}`);

      // Pane counts: editor has 2, logs has 1.
      const paneLines = tmuxQ(socketName, [
        "list-panes",
        "-s",
        "-t",
        "t1",
        "-F",
        "#{window_name}\t#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}",
      ])
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [win, pane, left, top, w, h, cwd] = l.split("\t");
          return { win, pane, left: +left!, top: +top!, w: +w!, h: +h!, cwd };
        });
      const editorPanes = paneLines.filter((p) => p.win === "editor");
      const logsPanes = paneLines.filter((p) => p.win === "logs");
      assert.equal(editorPanes.length, 2, "editor window has 2 panes");
      assert.equal(logsPanes.length, 1, "logs window has 1 pane");

      // Geometry: vsplit ⇒ the two editor panes are STACKED (same left+width,
      // distinct tops).
      const [pa, pb] = editorPanes.sort((a, b) => a.top - b.top);
      assert.equal(pa!.left, pb!.left, "stacked panes share pane_left");
      assert.equal(pa!.w, pb!.w, "stacked panes share width");
      assert.notEqual(pa!.top, pb!.top, "stacked panes have distinct tops (vsplit)");
      assert.equal(pa!.top, 0, "leaf 0 (top pane) is at y=0");

      // cwd: the top pane (leaf 0 = pane A) is in dirA.
      assert.equal(pa!.cwd, dirA, "pane A pane_current_path == the -c cwd");

      // env + cwd landed in the pane (file-write proves -e and the shell cwd).
      await waitFor(() => fs.existsSync(`${dirA}/env.txt`), 8_000, "pane A env.txt");
      assert.equal(fs.readFileSync(`${dirA}/env.txt`, "utf8"), "gjdx3-marker", "-e env reached the pane");
      assert.equal(
        fs.readFileSync(`${dirA}/cwd.txt`, "utf8").trim(),
        dirA,
        "pane A cwd (pwd) == the -c cwd",
      );

      // Awareness: @tmuxcc-template set on the session.
      assert.equal(
        tmuxQ(socketName, ["display-message", "-p", "-t", "t1", "-F", "#{@tmuxcc-template}"]),
        "devtmpl",
        "@tmuxcc-template session option is set to the template name",
      );

      // Surfaced on the session row: a FRESH command client's snapshot carries it.
      const fresh = await connectCommand(sp.endpoint());
      const row = fresh.snapshot.sessions.find((s) => s.name === "t1");
      assert.ok(row, "session t1 present in snapshot");
      assert.equal(row!.template, "devtmpl", "session row surfaces the applied template");
    } finally {
      await sp.shutdown();
      killServer(socketName);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      fs.rmSync(dirA, { recursive: true, force: true });
    }
  });

  it("T2: exactly-once under racing claims (only the created:true claimant applies)", async (t) => {
    if (!haveTmux) return t.skip("tmux not available");
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir();
    const sp = createServerProxy({ socketName, runtimeDir });
    await sp.start();
    try {
      const { mux } = await connectCommand(sp.endpoint());
      const template: SessionTemplate = { name: "race", windows: [{ name: "alpha" }, { name: "beta" }] };

      // Fire 4 concurrent claims for the SAME name WITHOUT awaiting between them.
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          sendCommand(mux, { kind: "session.claim", name: "shared", template }),
        ),
      );

      const createdFlags = responses.map((r) => okPayload(r).created);
      const createdCount = createdFlags.filter((c) => c === true).length;
      assert.equal(createdCount, 1, `exactly one claimant sees created:true (got ${JSON.stringify(createdFlags)})`);

      // Topology proves a SINGLE application — not doubled/quadrupled.
      const winNames = tmuxQ(socketName, ["list-windows", "-t", "shared", "-F", "#{window_name}"])
        .split("\n")
        .filter(Boolean)
        .sort();
      assert.deepEqual(winNames, ["alpha", "beta"], `single application ⇒ exactly [alpha,beta], got ${winNames.join(",")}`);
    } finally {
      await sp.shutdown();
      killServer(socketName);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("T3: no apply on reattach — a re-claim of an existing session (created:false) does NOT apply", async (t) => {
    if (!haveTmux) return t.skip("tmux not available");
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir();
    const sp = createServerProxy({ socketName, runtimeDir });
    await sp.start();
    try {
      const { mux } = await connectCommand(sp.endpoint());

      const first: SessionTemplate = { name: "orig", windows: [{ name: "a" }, { name: "b" }] };
      const r1 = await sendCommand(mux, { kind: "session.claim", name: "reattach", template: first });
      assert.equal(okPayload(r1).created, true);

      // Re-claim the SAME name with a DIFFERENT template → attaches (created:false).
      const second: SessionTemplate = { name: "other", windows: [{ name: "x" }, { name: "y" }, { name: "z" }] };
      const r2 = await sendCommand(mux, { kind: "session.claim", name: "reattach", template: second });
      assert.equal(okPayload(r2).created, false, "re-claim of an existing session attaches, does not mint");

      // Topology is UNCHANGED — the second template was NOT applied.
      const winNames = tmuxQ(socketName, ["list-windows", "-t", "reattach", "-F", "#{window_name}"])
        .split("\n")
        .filter(Boolean)
        .sort();
      assert.deepEqual(winNames, ["a", "b"], `no re-apply ⇒ still [a,b], got ${winNames.join(",")}`);
      // Awareness stays the FIRST template's identity (not re-stamped).
      assert.equal(
        tmuxQ(socketName, ["display-message", "-p", "-t", "reattach", "-F", "#{@tmuxcc-template}"]),
        "orig",
      );
    } finally {
      await sp.shutdown();
      killServer(socketName);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("T4: mid-transaction failure is loud (failed verb + created-so-far) with NO rollback", async (t) => {
    if (!haveTmux) return t.skip("tmux not available");
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir();
    const sp = createServerProxy({ socketName, runtimeDir });
    await sp.start();
    try {
      const { mux } = await connectCommand(sp.endpoint());

      // Window 1 ("ok") applies fine.  Window 2 ("toomany") is an hsplit of 16
      // leaves: chain-splitting the last pane halves its width each time, so a
      // split hits tmux's minimum-pane-size wall ("no space for new pane") long
      // before 16 — a deterministic, size-independent mid-transaction failure.
      const template: SessionTemplate = {
        name: "boom",
        windows: [
          { name: "ok" },
          {
            name: "toomany",
            geometry: { kind: "hsplit", children: Array.from({ length: 16 }, () => ({ kind: "pane" as const })) },
          },
        ],
      };

      const resp = await sendCommand(mux, { kind: "session.create", name: "t4", template });
      assert.equal(resp.result.ok, false, "apply failed ⇒ loud failure response");
      const fail = resp.result as { ok: false; code: string; message: string };
      assert.equal(fail.code, "template.invalid", "wire code names the template failure");
      assert.match(fail.message, /split-pane/, "message names the failed verb");
      assert.match(fail.message, /no rollback/i, "message states no rollback");
      // created-so-far: the "ok" window is named in the report.
      assert.match(fail.message, /@\d+\[/, "message carries the created-so-far topology (@<win>[panes])");

      // NO rollback: the session persists with the partial topology — at minimum
      // the fully-created first template window survives (the throwaway initial
      // window also survives because kill-window never ran).
      const winNames = tmuxQ(socketName, ["list-windows", "-t", "t4", "-F", "#{window_name}"])
        .split("\n")
        .filter(Boolean);
      assert.ok(winNames.includes("ok"), `partial session preserved (no rollback); windows = ${winNames.join(",")}`);
    } finally {
      await sp.shutdown();
      killServer(socketName);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("T5: coalescer absorbs a many-window apply burst — model converges, no refuted-confirmation tripwire", async (t) => {
    if (!haveTmux) return t.skip("tmux not available");
    const socketName = nextSocketName();
    const runtimeDir = makeRuntimeDir();
    const sp = createServerProxy({ socketName, runtimeDir });
    await sp.start();
    try {
      const { mux } = await connectCommand(sp.endpoint());

      // 6 windows; two of them multi-pane. A burst of new-window/split-pane/
      // select-layout/kill-window the tc-128 coalescer must absorb.
      const pane = { kind: "pane" as const };
      const template: SessionTemplate = {
        name: "storm",
        windows: [
          { name: "w0" },
          { name: "w1", geometry: { kind: "hsplit", children: [pane, pane, pane] } },
          { name: "w2" },
          { name: "w3", geometry: { kind: "vsplit", children: [pane, pane] } },
          { name: "w4" },
          { name: "w5" },
        ],
      };

      const resp = await sendCommand(mux, { kind: "session.create", name: "t5", template });
      const payload = okPayload(resp);
      assert.equal(payload.created, true);
      const sessionId = payload.sessionId!;

      // Ground truth: 6 windows, 3+2+1*4 = 9 panes.
      const winCount = tmuxQ(socketName, ["list-windows", "-t", "t5", "-F", "#{window_id}"])
        .split("\n")
        .filter(Boolean).length;
      assert.equal(winCount, 6, "all 6 template windows exist (initial window killed)");

      // The session-proxy model CONVERGES asynchronously via its requery
      // pipeline after the burst; attach once and follow the delta stream until
      // it reaches the expected topology, so we assert on the CONVERGED model
      // (the coalescer absorbed the storm), not a mid-flight one.
      const dataMux = await attachAwaitTopology(sp.endpoint(), sessionId, 6, 9, 20_000);

      // No refuted-confirmation tripwire: the requery engine's expected-zero
      // `requery_teardown_confirmations_total{outcome="refuted"}` stayed 0.
      const infoResp = await sendCommand(dataMux, { kind: "session-proxy.info" });
      assert.ok(infoResp.result.ok, "session-proxy.info ok");
      const metricsText = (
        infoResp.result as { ok: true; payload: { info: { metricsText: string } } }
      ).payload.info.metricsText;
      const refuted = matchCounter(metricsText, "requery_teardown_confirmations_total", 'outcome="refuted"');
      assert.equal(refuted, 0, `no refuted-confirmation tripwire (got ${refuted})`);
    } finally {
      await sp.shutdown();
      killServer(socketName);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});

/**
 * Read a Prometheus counter value for a metric line whose label set contains
 * `labelSubstr`; returns 0 when the line is absent (an unincremented counter may
 * not be exposed).
 */
function matchCounter(metricsText: string, metric: string, labelSubstr: string): number {
  for (const line of metricsText.split("\n")) {
    if (line.startsWith("#")) continue;
    if (line.startsWith(metric) && line.includes(labelSubstr)) {
      const val = line.trim().split(/\s+/).pop();
      const n = Number(val);
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
}
