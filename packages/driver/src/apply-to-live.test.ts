/**
 * apply-to-live.test.ts — real-tmux behavioral coverage for the tc-gjdx.4
 * apply-to-live merge-diff + preview (idempotent safe direction).
 *
 * AC behavioral guarantees:
 *   T1. Preview equals the subsequent apply's created set (preview-equals-apply
 *       invariant): dryRun and real apply compute the same would-create set via
 *       the shared templateDiff function.
 *   T2. Name-matching windows are left alone — only missing windows/panes are
 *       created (idempotent safe direction).
 *   T3. A re-apply of the same template to an already-satisfied session is a
 *       no-op (empty diff, no tmux side effects).
 *   T4. Mid-apply failure surfaces a loud error (failed verb + created-so-far
 *       state) with NO rollback; existing windows are untouched; failure
 *       semantics match tc-gjdx.3.
 *
 * Seeding: tests that need a clean baseline use session.create WITH a template
 * so apply-at-create (tc-gjdx.3) kills the throwaway initial window and the
 * session starts with exactly the seeded windows.
 *
 * Harness: each test spins up its own broker on a unique `-L` socket + private
 * runtime dir, tmux-guarded, and issues real `tmux` queries for ground truth.
 * Runs in the serialized real-tmux lane (--test-concurrency=1).
 *
 * @module apply-to-live.test
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
  SessionTemplate,
  TemplateApplyResult,
} from "@tmuxcc/protocol";
import { mintSocket } from "./runtime/test-tmux-cleanup.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-gjdx4-rt-"));
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
    const timer = setTimeout(
      () => reject(new Error(`command ${String(command.kind)} timeout`)),
      20_000,
    );
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

interface OkPayload {
  sessionId?: string;
  created?: boolean;
  name?: string;
}
function okPayload(resp: ServerProxyCommandResponseMessage): OkPayload {
  assert.ok(resp.result.ok, `expected ok, got ${JSON.stringify(resp.result)}`);
  return (resp.result as { ok: true; payload: OkPayload }).payload;
}

function applyResult(resp: ServerProxyCommandResponseMessage): TemplateApplyResult {
  assert.ok(resp.result.ok, `expected ok, got ${JSON.stringify(resp.result)}`);
  const payload = (resp.result as { ok: true; payload: { applyTemplate: TemplateApplyResult } }).payload;
  assert.ok(payload.applyTemplate !== undefined, "response payload must carry applyTemplate");
  return payload.applyTemplate;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("apply-to-live (tc-gjdx.4, real tmux)", () => {
  let haveTmux = false;
  before(() => {
    haveTmux = tmuxAvailable();
  });

  it("T1: preview (dryRun) equals the subsequent apply's created set", async (t) => {
    if (!haveTmux) return t.skip("tmux not available");
    const socketName = mintSocket("gjdx4");
    const runtimeDir = makeRuntimeDir();
    const sp = createServerProxy({ socketName, runtimeDir });
    await sp.start();
    try {
      const { mux } = await connectCommand(sp.endpoint());

      // Seed: create the session WITH a template so apply-at-create kills the
      // throwaway initial window and the session starts with exactly ["existing"].
      const seedTemplate: SessionTemplate = { windows: [{ name: "existing" }] };
      const r1 = await sendCommand(mux, {
        kind: "session.create",
        name: "t1sess",
        template: seedTemplate,
      });
      const p1 = okPayload(r1);
      assert.equal(p1.created, true);
      const sessionId = p1.sessionId!;

      // Confirm seed: exactly ["existing"].
      const afterSeed = tmuxQ(socketName, ["list-windows", "-t", "t1sess", "-F", "#{window_name}"])
        .split("\n").filter(Boolean).sort();
      assert.deepEqual(afterSeed, ["existing"], `seed has exactly [existing], got ${afterSeed.join(",")}`);

      // The template to preview + apply: "existing" (name-match → skip) + "alpha" + "beta".
      const template: SessionTemplate = {
        windows: [{ name: "existing" }, { name: "alpha" }, { name: "beta" }],
      };

      // --- dryRun preview ---
      const previewResp = await sendCommand(mux, {
        kind: "session.applyTemplate",
        sessionId,
        template,
        dryRun: true,
      });
      const preview = applyResult(previewResp);
      assert.equal(preview.dryRun, true, "preview echoes dryRun:true");
      const previewNames = preview.windows.map((w) => w.name).sort();
      assert.deepEqual(
        previewNames,
        ["alpha", "beta"],
        `preview would-create = [alpha,beta], got ${previewNames.join(",")}`,
      );

      // dryRun must NOT create windows.
      const afterDry = tmuxQ(socketName, ["list-windows", "-t", "t1sess", "-F", "#{window_name}"])
        .split("\n").filter(Boolean).sort();
      assert.deepEqual(afterDry, ["existing"], `dryRun must not create windows (got ${afterDry.join(",")})`);

      // --- real apply ---
      const applyResp = await sendCommand(mux, {
        kind: "session.applyTemplate",
        sessionId,
        template,
      });
      const applied = applyResult(applyResp);
      assert.equal(applied.dryRun, false, "real apply echoes dryRun:false");
      const appliedNames = applied.windows.map((w) => w.name).sort();

      // preview-equals-apply: did-create set must equal would-create set.
      assert.deepEqual(
        appliedNames,
        previewNames,
        `did-create set must equal would-create set (preview-equals-apply AC)`,
      );

      // Ground truth: exactly [existing, alpha, beta].
      const liveNames = tmuxQ(socketName, ["list-windows", "-t", "t1sess", "-F", "#{window_name}"])
        .split("\n").filter(Boolean).sort();
      assert.deepEqual(
        liveNames,
        ["alpha", "beta", "existing"],
        `live windows after apply = [alpha,beta,existing], got ${liveNames.join(",")}`,
      );
    } finally {
      await sp.shutdown();
      killServer(socketName);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("T2: name-matching windows are left alone — only missing windows are created", async (t) => {
    if (!haveTmux) return t.skip("tmux not available");
    const socketName = mintSocket("gjdx4");
    const runtimeDir = makeRuntimeDir();
    const sp = createServerProxy({ socketName, runtimeDir });
    await sp.start();
    try {
      const { mux } = await connectCommand(sp.endpoint());

      // Seed: create the session WITH a template so throwaway is killed and the
      // session starts with exactly ["editor", "logs"].
      const seedTemplate: SessionTemplate = {
        windows: [{ name: "editor" }, { name: "logs" }],
      };
      const r1 = await sendCommand(mux, {
        kind: "session.create",
        name: "t2sess",
        template: seedTemplate,
      });
      const sessionId = okPayload(r1).sessionId!;

      // Capture the window IDs of the existing windows to verify they are
      // NOT replaced (same ids after apply-to-live).
      const beforeIds = tmuxQ(socketName, [
        "list-windows", "-t", "t2sess", "-F", "#{window_id}\t#{window_name}",
      ])
        .split("\n").filter(Boolean)
        .map((l) => { const [id, name] = l.split("\t"); return { id: id!, name: name! }; });
      const editorIdBefore = beforeIds.find((w) => w.name === "editor")?.id;
      const logsIdBefore = beforeIds.find((w) => w.name === "logs")?.id;
      assert.ok(editorIdBefore, "editor window exists after seed");
      assert.ok(logsIdBefore, "logs window exists after seed");

      // apply-to-live: "editor" (existing — must be left alone) + "terminal" (missing).
      const template: SessionTemplate = {
        windows: [{ name: "editor" }, { name: "terminal" }],
      };
      const a1 = await sendCommand(mux, {
        kind: "session.applyTemplate",
        sessionId,
        template,
      });
      const result = applyResult(a1);
      assert.equal(result.dryRun, false);
      const createdNames = result.windows.map((w) => w.name);
      assert.deepEqual(
        createdNames,
        ["terminal"],
        `only "terminal" should be created, got ${createdNames.join(",")}`,
      );

      // editor and logs still present with the SAME window IDs (untouched).
      const afterIds = tmuxQ(socketName, [
        "list-windows", "-t", "t2sess", "-F", "#{window_id}\t#{window_name}",
      ])
        .split("\n").filter(Boolean)
        .map((l) => { const [id, name] = l.split("\t"); return { id: id!, name: name! }; });
      const editorIdAfter = afterIds.find((w) => w.name === "editor")?.id;
      const logsIdAfter = afterIds.find((w) => w.name === "logs")?.id;
      assert.equal(editorIdAfter, editorIdBefore, "editor window id unchanged (not replaced)");
      assert.equal(logsIdAfter, logsIdBefore, "logs window id unchanged (not replaced)");
      assert.ok(afterIds.some((w) => w.name === "terminal"), "terminal window was created");

      // Ground truth: exactly [editor, logs, terminal].
      const liveNames = afterIds.map((w) => w.name).sort();
      assert.deepEqual(liveNames, ["editor", "logs", "terminal"], `live windows = [editor,logs,terminal], got ${liveNames.join(",")}`);
    } finally {
      await sp.shutdown();
      killServer(socketName);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("T3: re-apply of the same template is a no-op (empty diff)", async (t) => {
    if (!haveTmux) return t.skip("tmux not available");
    const socketName = mintSocket("gjdx4");
    const runtimeDir = makeRuntimeDir();
    const sp = createServerProxy({ socketName, runtimeDir });
    await sp.start();
    try {
      const { mux } = await connectCommand(sp.endpoint());

      // Seed: create the session WITH the same template we'll re-apply so
      // apply-at-create kills the throwaway and the session starts with
      // exactly [w1, w2, w3].
      const template: SessionTemplate = {
        name: "idempotent",
        windows: [{ name: "w1" }, { name: "w2" }, { name: "w3" }],
      };
      const r1 = await sendCommand(mux, {
        kind: "session.create",
        name: "t3sess",
        template,
      });
      const sessionId = okPayload(r1).sessionId!;

      // Confirm seed: exactly [w1, w2, w3].
      const afterSeed = tmuxQ(socketName, ["list-windows", "-t", "t3sess", "-F", "#{window_name}"])
        .split("\n").filter(Boolean).sort();
      assert.deepEqual(afterSeed, ["w1", "w2", "w3"], `seed has exactly [w1,w2,w3], got ${afterSeed.join(",")}`);

      // First re-apply: the template is already fully satisfied → empty diff.
      const a1 = await sendCommand(mux, { kind: "session.applyTemplate", sessionId, template });
      const r1a = applyResult(a1);
      assert.equal(r1a.dryRun, false, "re-apply is not dryRun");
      assert.equal(r1a.windows.length, 0, `first re-apply is a no-op (empty diff), got ${r1a.windows.length} windows`);

      // Ground truth: still exactly [w1, w2, w3].
      const liveNames = tmuxQ(socketName, ["list-windows", "-t", "t3sess", "-F", "#{window_name}"])
        .split("\n").filter(Boolean).sort();
      assert.deepEqual(liveNames, ["w1", "w2", "w3"], `live windows unchanged after re-apply, got ${liveNames.join(",")}`);

      // Second re-apply — same no-op guarantee.
      const a2 = await sendCommand(mux, { kind: "session.applyTemplate", sessionId, template });
      const r2a = applyResult(a2);
      assert.equal(r2a.windows.length, 0, "second re-apply is also a no-op");
    } finally {
      await sp.shutdown();
      killServer(socketName);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("T4: mid-apply failure is loud (failed verb + created-so-far) with NO rollback; existing windows untouched", async (t) => {
    if (!haveTmux) return t.skip("tmux not available");
    const socketName = mintSocket("gjdx4");
    const runtimeDir = makeRuntimeDir();
    const sp = createServerProxy({ socketName, runtimeDir });
    await sp.start();
    try {
      const { mux } = await connectCommand(sp.endpoint());

      // Seed: create the session WITH a template so apply-at-create kills the
      // throwaway and the session starts with exactly ["pre-existing"].
      const seedTemplate: SessionTemplate = { windows: [{ name: "pre-existing" }] };
      const r1 = await sendCommand(mux, {
        kind: "session.create",
        name: "t4sess",
        template: seedTemplate,
      });
      const sessionId = okPayload(r1).sessionId!;

      // Capture the pre-existing window ID before the failing apply.
      const preIds = tmuxQ(socketName, [
        "list-windows", "-t", "t4sess", "-F", "#{window_id}\t#{window_name}",
      ])
        .split("\n").filter(Boolean)
        .map((l) => { const [id, name] = l.split("\t"); return { id: id!, name: name! }; });
      const preExistingId = preIds.find((w) => w.name === "pre-existing")?.id;
      assert.ok(preExistingId, "pre-existing window present before failing apply");

      // Template: "good" (creates fine) + "toomany" (16-leaf hsplit → hits tmux
      // minimum-pane-size wall mid-transaction — same deterministic failure as
      // T4 in apply-at-create.test.ts).
      const template: SessionTemplate = {
        windows: [
          { name: "good" },
          {
            name: "toomany",
            geometry: {
              kind: "hsplit",
              children: Array.from({ length: 16 }, () => ({ kind: "pane" as const })),
            },
          },
        ],
      };

      const failResp = await sendCommand(mux, {
        kind: "session.applyTemplate",
        sessionId,
        template,
      });

      assert.equal(failResp.result.ok, false, "failing apply must return ok:false");
      const fail = failResp.result as { ok: false; code: string; message: string };
      assert.equal(fail.code, "template.invalid", "wire code names the template failure");
      assert.match(fail.message, /split-pane/, "message names the failed verb");
      assert.match(fail.message, /no rollback/i, "message states no rollback");
      // created-so-far topology includes the "good" window.
      assert.match(fail.message, /@\d+\[/, "message carries the created-so-far topology");

      // NO rollback: pre-existing window still present with the SAME id.
      const afterIds = tmuxQ(socketName, [
        "list-windows", "-t", "t4sess", "-F", "#{window_id}\t#{window_name}",
      ])
        .split("\n").filter(Boolean)
        .map((l) => { const [id, name] = l.split("\t"); return { id: id!, name: name! }; });
      const preExistingIdAfter = afterIds.find((w) => w.name === "pre-existing")?.id;
      assert.equal(preExistingIdAfter, preExistingId, "pre-existing window untouched (same id) after partial failure");
      assert.ok(
        afterIds.some((w) => w.name === "good"),
        `partial session preserved: "good" window created before failure`,
      );
    } finally {
      await sp.shutdown();
      killServer(socketName);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
