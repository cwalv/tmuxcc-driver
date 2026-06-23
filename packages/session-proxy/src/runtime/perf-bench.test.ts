/**
 * tc-4sg — Hot-path throughput benchmark.
 *
 * Measures MB/s for sub-stages of the %output hot path:
 *   1. tokenizer.push()      — raw bytes → NotificationToken (with rawLine)
 *   2. decodeOutputPayload() — octal-escaped payload → raw pane bytes
 *   3. scrollback.append()   — raw bytes → PaneBufferStore chunk list
 *   4. full pipeline         — tokenize → decode → append (through demux tap)
 *
 * NOT a correctness test — numbers are logged, not asserted tightly.
 * Asserts only:
 *   - Benchmark completes (no throw)
 *   - Decoded byte count is positive and plausible
 *
 * Bounded input: ~8 MB of synthetic %output lines → completes in seconds.
 * Safe to run in CI (no tight timing assertions).
 *
 * @module runtime/perf-bench.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ControlTokenizer } from "../parser/tokenizer.js";
import { decodeOutputPayload, encodeOutputPayload } from "../parser/output-codec.js";
import { createPaneBufferStore } from "../state/scrollback.js";
import { createOutputDemux } from "./output-demux.js";
import { paneId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** High-resolution elapsed time in seconds. */
function elapsed(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}

/** Format throughput as "X.XX MB/s". */
function fmtMbps(bytes: number, secs: number): string {
  return ((bytes / secs) / 1_048_576).toFixed(2) + " MB/s";
}

// ---------------------------------------------------------------------------
// Synthetic %output line generator
//
// Produces a byte buffer containing N copies of:
//   %output %0 <escaped-payload>\n
//
// The payload is a mix of printable ASCII (most bytes pass through literally)
// and some control chars (octal-escaped) to exercise the decoder's escape path.
// ---------------------------------------------------------------------------

const PANE_PREFIX = new TextEncoder().encode("%output %0 ");
const LF = new Uint8Array([0x0a]);

/**
 * Build a single representative %output payload line.
 *
 * @param lineBytes Target length of the raw pane data (before encoding).
 * @returns Encoded %output line bytes (with trailing LF), ready to feed to tokenizer.
 */
function buildOutputLine(lineBytes: number): Uint8Array {
  // Raw pane data: mix of printable ASCII + some control chars.
  const raw = new Uint8Array(lineBytes);
  for (let i = 0; i < lineBytes; i++) {
    // ~10% control chars (0x00–0x1F) to exercise octal decoder; rest printable.
    raw[i] = i % 10 === 0 ? (i % 32) : (0x20 + (i % 94));
  }
  const encoded = encodeOutputPayload(raw);

  // %output %0 <encoded>\n
  const line = new Uint8Array(PANE_PREFIX.length + encoded.length + LF.length);
  line.set(PANE_PREFIX, 0);
  line.set(encoded, PANE_PREFIX.length);
  line.set(LF, PANE_PREFIX.length + encoded.length);
  return line;
}

/**
 * Repeat `line` N times into a single buffer.
 */
function repeatLine(line: Uint8Array, count: number): Uint8Array {
  const buf = new Uint8Array(line.length * count);
  for (let i = 0; i < count; i++) {
    buf.set(line, i * line.length);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Benchmark parameters
//
// LINE_RAW_BYTES: raw pane bytes per %output line (before encoding).
//   Typical tmux chunk: 512–4096 bytes. Use 1024 as representative.
//
// TARGET_ENCODED_MB: total encoded input size to process (~8 MB → ~seconds).
// ---------------------------------------------------------------------------

const LINE_RAW_BYTES = 1024;

// One line: prefix (11) + encoded payload (≤ 4×1024 = 4096 worst-case) + LF.
// With 10% control chars, encoded ≈ 1024 + 0.10*1024*3 = ~1331 bytes.
const LINE = buildOutputLine(LINE_RAW_BYTES);
const LINE_COUNT = Math.ceil((8 * 1_048_576) / LINE.length); // ~8 MB of %output lines
const INPUT_BUF = repeatLine(LINE, LINE_COUNT);
const INPUT_BYTES = INPUT_BUF.length;

// Payload slice (without prefix and LF) for isolated decode benchmark.
const PAYLOAD_ONLY = LINE.subarray(PANE_PREFIX.length, LINE.length - 1);

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("tc-4sg: hot-path throughput benchmark", () => {
  // -------------------------------------------------------------------------
  // Stage 1: Tokenizer throughput
  // -------------------------------------------------------------------------

  it("stage 1 — tokenizer: raw byte stream → notification tokens", () => {
    const tok = new ControlTokenizer();

    const t0 = process.hrtime.bigint();
    const tokens = tok.push(INPUT_BUF);
    const secs = elapsed(t0);

    // Sanity: we should get LINE_COUNT notification tokens.
    const notifs = tokens.filter((t) => t.kind === "notification");
    assert.ok(notifs.length > 0, `tokenizer must emit notification tokens; got ${tokens.length} total`);

    const mbps = fmtMbps(INPUT_BYTES, secs);
    console.log(
      `[perf] tokenizer: ${INPUT_BYTES.toLocaleString()} bytes, ` +
      `${notifs.length} tokens, ${secs.toFixed(3)}s → ${mbps}`,
    );

    // Loose sanity: must be faster than 1 MB/s (any real machine does >> this)
    assert.ok(INPUT_BYTES / secs > 1_048_576, `tokenizer throughput must exceed 1 MB/s; got ${mbps}`);
  });

  // -------------------------------------------------------------------------
  // Stage 2: Decoder throughput (isolated — no tokenizer overhead)
  // -------------------------------------------------------------------------

  it("stage 2 — decodeOutputPayload: octal-escaped payload → raw bytes", () => {
    const DECODE_REPS = LINE_COUNT;
    let decodedTotal = 0;

    const t0 = process.hrtime.bigint();
    for (let i = 0; i < DECODE_REPS; i++) {
      const out = decodeOutputPayload(PAYLOAD_ONLY);
      decodedTotal += out.length;
    }
    const secs = elapsed(t0);

    assert.ok(decodedTotal > 0, "decoded byte total must be positive");

    // Input throughput: DECODE_REPS × PAYLOAD_ONLY.length bytes processed.
    const inputBytes = DECODE_REPS * PAYLOAD_ONLY.length;
    const mbps = fmtMbps(inputBytes, secs);
    console.log(
      `[perf] decodeOutputPayload: ${inputBytes.toLocaleString()} encoded bytes, ` +
      `${decodedTotal.toLocaleString()} decoded bytes, ${secs.toFixed(3)}s → ${mbps}`,
    );

    assert.ok(inputBytes / secs > 1_048_576, `decoder throughput must exceed 1 MB/s; got ${mbps}`);
  });

  // -------------------------------------------------------------------------
  // Stage 3: PaneBufferStore.append throughput
  // -------------------------------------------------------------------------

  it("stage 3 — scrollback append: push decoded chunks into PaneBufferStore", () => {
    const store = createPaneBufferStore({ capBytes: 64 * 1_048_576 }); // 64 MiB cap — no eviction during bench
    const pid = paneId("p0");

    // Pre-build decoded chunks to isolate append from decode.
    const CHUNK = decodeOutputPayload(PAYLOAD_ONLY);
    const APPEND_COUNT = LINE_COUNT;
    let appendedTotal = 0;

    const t0 = process.hrtime.bigint();
    for (let i = 0; i < APPEND_COUNT; i++) {
      store.append(pid, CHUNK);
      appendedTotal += CHUNK.length;
    }
    const secs = elapsed(t0);

    assert.ok(appendedTotal > 0, "appended byte total must be positive");

    const mbps = fmtMbps(appendedTotal, secs);
    console.log(
      `[perf] scrollback.append: ${appendedTotal.toLocaleString()} bytes, ` +
      `${APPEND_COUNT} appends, ${secs.toFixed(3)}s → ${mbps}`,
    );

    assert.ok(appendedTotal / secs > 1_048_576, `scrollback.append throughput must exceed 1 MB/s; got ${mbps}`);
  });

  // -------------------------------------------------------------------------
  // Stage 4: Full hot path (tokenize → decode → demux.append)
  //
  // Feeds the full encoded INPUT_BUF through the tokenizer; for each
  // %output notification, decodes the payload and appends via demux store.
  // No real transport attached (no encodeFrame overhead here — that's the
  // wire transport's responsibility and is measured in stage 5).
  // -------------------------------------------------------------------------

  it("stage 4 — full pipeline: tokenize → decode → scrollback (no transport)", () => {
    const demux = createOutputDemux();
    const pid = paneId("p0");
    const tok = new ControlTokenizer();
    let decodedTotal = 0;

    const t0 = process.hrtime.bigint();
    const tokens = tok.push(INPUT_BUF);
    for (const token of tokens) {
      if (token.kind !== "notification" || token.keyword !== "output") continue;
      // Decode payload: rawLine is "%output %0 <payload>"
      const rawLine = token.rawLine;
      // Skip "%output %0 " prefix (11 bytes)
      const payload = rawLine.subarray(PANE_PREFIX.length);
      const decoded = decodeOutputPayload(payload);
      demux.store.append(pid, decoded);
      decodedTotal += decoded.length;
    }
    const secs = elapsed(t0);

    assert.ok(decodedTotal > 0, "full pipeline must decode > 0 bytes");

    const mbps = fmtMbps(INPUT_BYTES, secs);
    console.log(
      `[perf] full pipeline (no transport): ${INPUT_BYTES.toLocaleString()} encoded bytes in, ` +
      `${decodedTotal.toLocaleString()} decoded bytes stored, ${secs.toFixed(3)}s → ${mbps} (encoded input rate)`,
    );

    assert.ok(INPUT_BYTES / secs > 1_048_576, `full pipeline throughput must exceed 1 MB/s; got ${mbps}`);
  });

  // -------------------------------------------------------------------------
  // Stage 5: Full pipeline with in-memory transport (encodeFrame overhead)
  //
  // Attaches a null transport (sendData = no-op sink) to measure the
  // tokenize → decode → demux.append → sendData fan-out cost including
  // the alloc per sendData call in a real transport.
  // -------------------------------------------------------------------------

  it("stage 5 — full pipeline with transport tap (sendData overhead)", () => {
    // Null transport: counts bytes received but does no framing.
    let transportBytes = 0;
    const nullTransport = {
      sendData(_pid: ReturnType<typeof paneId>, bytes: Uint8Array): void {
        transportBytes += bytes.length;
      },
      sendControl(_msg: unknown): void { /**/ },
      onControl(_cb: (_msg: unknown) => void): () => void { return () => {}; },
      onData(_cb: (_pid: ReturnType<typeof paneId>, _bytes: Uint8Array) => void): () => void { return () => {}; },
      onClose(_cb: (_err?: Error) => void): () => void { return () => {}; },
      close(_err?: Error): void { /**/ },
      closeGracefully(_err?: Error): Promise<void> { return Promise.resolve(); },
    };

    const demux = createOutputDemux();
    demux.attachTransport(nullTransport as Parameters<typeof demux.attachTransport>[0]);
    const pid = paneId("p0");
    // tc-128.4: pane tracking is always-on in the demux — bind the pane
    // explicitly so bytes fan out instead of staging in the pre-topology
    // buffer (this is the benchmark; we're measuring the live fan-out path).
    demux.notifyPaneBound(pid);
    const tok = new ControlTokenizer();
    let decodedTotal = 0;

    const t0 = process.hrtime.bigint();
    const tokens = tok.push(INPUT_BUF);
    for (const token of tokens) {
      if (token.kind !== "notification" || token.keyword !== "output") continue;
      const payload = token.rawLine.subarray(PANE_PREFIX.length);
      const decoded = decodeOutputPayload(payload);
      demux.store.append(pid, decoded);
      decodedTotal += decoded.length;
    }
    const secs = elapsed(t0);

    assert.ok(decodedTotal > 0, "pipeline-with-transport must decode > 0 bytes");
    assert.ok(transportBytes > 0, "null transport must have received bytes");

    const mbps = fmtMbps(INPUT_BYTES, secs);
    console.log(
      `[perf] full pipeline (with transport tap): ${INPUT_BYTES.toLocaleString()} encoded bytes, ` +
      `${decodedTotal.toLocaleString()} decoded bytes, ${transportBytes.toLocaleString()} transport bytes, ` +
      `${secs.toFixed(3)}s → ${mbps}`,
    );

    assert.ok(INPUT_BYTES / secs > 1_048_576, `pipeline-with-transport throughput must exceed 1 MB/s; got ${mbps}`);
  });
});
