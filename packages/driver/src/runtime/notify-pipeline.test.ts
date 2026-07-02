/**
 * Integration tests for the pane.notify pipeline (tc-76m8.1, S9).
 *
 * Drives the REAL RuntimePipeline (fake tmux host) end-to-end: a `%output`
 * frame carrying an escape → the escape scanner → the rate limiter → the
 * onPaneNotify seam + the metrics counters. Asserts the load-bearing contracts:
 *   - pane.notify fires for BOTH bound and unbound panes (the driver is the
 *     sole observer of unbound panes).
 *   - the render path is byte-identical (the scanned bytes reach the pane
 *     buffer untouched — a BEL still flows through to light the native bell).
 *   - a storm is rate-limited and the Tier-1 drop tripwire fires (loud + metric).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRuntimePipeline } from "./pipeline.js";
import type { PaneNotifyEmission } from "./pipeline.js";
import { createSessionProxyRegistry } from "../metrics/registry.js";
import { createPaneBufferStore } from "../state/scrollback.js";
import { encodeOutputPayload } from "../parser/output-codec.js";
import { paneId } from "../state/model.js";
import type { TmuxHost, DataHandler, ExitHandler, ErrorHandler } from "./tmux-host.js";

// ---------------------------------------------------------------------------
// Minimal fake host + bootstrap (mirrors pipeline.test.ts's harness)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const b = (s: string): Uint8Array => enc.encode(s);

let _cmdNum = 500;
const nextCmdNum = (): number => _cmdNum++;
const cmdBlock = (n: number, body: string): string => `%begin 1000000 ${n} 1\r\n${body}%end 1000000 ${n} 1\r\n`;

class FakeHost implements TmuxHost {
  private _data = new Set<DataHandler>();
  private _exit = new Set<ExitHandler>();
  private _err = new Set<ErrorHandler>();
  private _stderr = new Set<DataHandler>();
  private _exited = false;
  get pid(): number | undefined { return 4242; }
  get exited(): boolean { return this._exited; }
  start(): Promise<void> { return Promise.resolve(); }
  write(data: string | Uint8Array | Buffer): void {
    const s = typeof data === "string" ? data : new TextDecoder().decode(data);
    const t = s.trim();
    // Auto-ack fire-and-forget setup commands so their correlator slots close.
    if (t.startsWith("set-option") || t.startsWith("refresh-client")) {
      const block = cmdBlock(nextCmdNum(), "");
      process.nextTick(() => { if (!this._exited) this.push(b(block)); });
    }
  }
  onData(h: DataHandler): () => void { this._data.add(h); return () => this._data.delete(h); }
  onExit(h: ExitHandler): () => void { this._exit.add(h); return () => this._exit.delete(h); }
  onError(h: ErrorHandler): () => void { this._err.add(h); return () => this._err.delete(h); }
  onStderr(h: DataHandler): () => void { this._stderr.add(h); return () => this._stderr.delete(h); }
  stop(): Promise<void> { this._exited = true; return Promise.resolve(); }
  kill(): void { this._exited = true; }
  push(bytes: Uint8Array): void { for (const h of this._data) h(bytes); }
}

/** One-session, one-window, one-pane (%1) bootstrap reply pair. */
function bootstrapReplies(): Uint8Array {
  const winBody = `$0\tsess\t@1\twin\t80\t24\taaaa,80x24,0,0,1\t*\t1\n`;
  const paneBody = `%1\t@1\t$0\t0\t80\t24\t0\t0\t1\t1234\tbash\n`;
  return b(cmdBlock(nextCmdNum(), winBody) + cmdBlock(nextCmdNum(), paneBody));
}

/** Feed a `%output %<paneNum> <payload>` frame carrying `raw` pty bytes. */
function outputFrame(paneNum: number, raw: Uint8Array): Uint8Array {
  const encoded = new TextDecoder("latin1").decode(encodeOutputPayload(raw));
  return b(`%output %${paneNum} ${encoded}\r\n`);
}

async function startPipeline() {
  const host = new FakeHost();
  const buffers = createPaneBufferStore();
  const metrics = createSessionProxyRegistry();
  const pipeline = createRuntimePipeline(host, { buffers, metrics });
  const emissions: PaneNotifyEmission[] = [];
  pipeline.onPaneNotify((n) => emissions.push(n));
  const started = pipeline.start();
  host.push(bootstrapReplies());
  await started;
  return { host, buffers, metrics, pipeline, emissions };
}

const ESC = 0x1b;
const BEL = 0x07;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pane.notify pipeline: emission", () => {
  it("emits bell for a BEL in a bound pane's %output", async () => {
    const { host, pipeline, emissions } = await startPipeline();
    host.push(outputFrame(1, Uint8Array.from([0x78, BEL, 0x79]))); // "x\ay"
    assert.deepEqual(emissions, [{ paneId: paneId("p1"), kind: "bell" }]);
    pipeline.stop();
  });

  it("emits osc9 for an OSC 9 notification and preserves the render bytes", async () => {
    const { host, buffers, pipeline, emissions } = await startPipeline();
    const raw = Uint8Array.from([
      0x68, 0x69, // "hi"
      ESC, 0x5d, 0x39, 0x3b, // ESC ] 9 ;
      ...b("done"),
      BEL,
    ]);
    host.push(outputFrame(1, raw));
    assert.deepEqual(emissions, [
      { paneId: paneId("p1"), kind: "osc9", payload: { message: "done", source: "osc9" } },
    ]);
    // Render path is byte-identical: the OSC 9 (a non-title OSC) is NOT stripped
    // and the scanner never modifies the stream. The pane buffer holds `raw`.
    assert.deepEqual(buffers.getContents(paneId("p1")), raw);
    pipeline.stop();
  });

  it("emits pane.notify for an UNBOUND pane (driver is the sole observer)", async () => {
    const { host, pipeline, emissions } = await startPipeline();
    // Pane %99 is NOT in the model — a foreign/unbound pane. The notify must
    // still fire (the whole point of driver-side recognition, S9).
    host.push(outputFrame(99, Uint8Array.from([BEL])));
    assert.deepEqual(emissions, [{ paneId: paneId("p99"), kind: "bell" }]);
    pipeline.stop();
  });

  it("records pane_notify_total{kind} in the metrics registry", async () => {
    const { host, metrics, pipeline } = await startPipeline();
    host.push(outputFrame(1, Uint8Array.from([BEL])));
    host.push(outputFrame(1, b("normal output, no escapes")));
    const text = await metrics.metrics();
    assert.match(text, /pane_notify_total\{kind="bell"\} 1/);
    pipeline.stop();
  });
});

describe("pane.notify pipeline: storm rate-limiting", () => {
  it("rate-limits a bell storm and fires the Tier-1 expected-zero drop tripwire", async () => {
    const { host, metrics, pipeline, emissions } = await startPipeline();

    // Capture the loud tripwire log (the fail-loud side of the counter).
    const origWrite = process.stderr.write.bind(process.stderr);
    let tripwireLines = 0;
    (process.stderr as { write: (s: string | Uint8Array) => boolean }).write = (s: string | Uint8Array) => {
      if (typeof s === "string" && s.includes("PANE-NOTIFY RATE LIMIT")) tripwireLines++;
      return true;
    };
    try {
      // 200 bells in a single frame (one synchronous tick) — far above the
      // per-pane burst budget.
      const storm = new Uint8Array(200).fill(BEL);
      host.push(outputFrame(1, storm));
    } finally {
      (process.stderr as { write: typeof origWrite }).write = origWrite;
    }

    assert.ok(emissions.length > 0, "some bells pass the burst budget");
    assert.ok(emissions.length < 200, `the storm was rate-limited (emitted ${emissions.length}/200)`);
    assert.ok(tripwireLines > 0, "a Tier-1 drop must loud-log the expected-zero tripwire");

    const text = await metrics.metrics();
    const m = text.match(/pane_notify_dropped_total\{kind="bell"\} (\d+)/);
    assert.ok(m, "pane_notify_dropped_total{kind=bell} must be present");
    assert.ok(Number(m![1]) > 0, "the bell drop counter must be non-zero after a storm");
    pipeline.stop();
  });
});
