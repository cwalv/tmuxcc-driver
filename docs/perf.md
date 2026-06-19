# tmuxcc Hot-Path Performance — tc-4sg

Bead: `tc-4sg` (E7 — End-to-end integration & hardening)  
Measured: 2026-05-29  
Benchmark: `src/runtime/perf-bench.test.ts`  
Input: ~8.4 MB of synthetic `%output` lines (6 128 lines × ~1 369 bytes each; 10% control-char density → octal-escaped)

## Throughput numbers

| Stage | Input (encoded) | Throughput |
|---|---|---|
| 1. Tokenizer (`ControlTokenizer.push`) | 8.4 MB | **393 MB/s** |
| 2. Decoder (`decodeOutputPayload`) | 8.3 MB encoded → 6.3 MB decoded | **363 MB/s** |
| 3. `scrollback.append` | 6.3 MB | **2 227 MB/s** |
| 4. Full pipeline — tokenize → decode → append (no transport) | 8.4 MB in | **226 MB/s** |
| 5. Full pipeline — with `sendData` fan-out tap | 8.4 MB in | **205 MB/s** |

Wall-clock for the full 8.4 MB pass: ~39 ms.

**End-to-end sustained rate: ~205 MB/s of encoded `%output` input.**  
A typical terminal firehose produces at most ~1–5 MB/s of encoded data. The pipeline has a factor-of-~40–200× headroom before becoming a bottleneck.

## Bottleneck analysis

### Where time goes

The full pipeline (stage 4/5) runs at 226/205 MB/s. Stage breakdown:

| Stage | Time share | Why |
|---|---|---|
| Tokenizer | ~55% | Byte-at-a-time scan inside `_processInside`; `_extractKeyword` builds a JS string char-by-char; `_collectLine` copies if lineBuf has >1 chunk |
| Decoder | ~43% | Single `new Uint8Array(payload.length)` alloc per call + linear scan; tight, no per-byte alloc |
| `scrollback.append` | ~2% | Pure list push + integer add; no copy; negligible |
| Demux fan-out | ~5% (stage 5 vs 4) | `Set.has` check + `Set` iteration; near zero with one transport |

### Allocation audit — per `%output` line processed

| Allocation | Where | Cost |
|---|---|---|
| `new Uint8Array(payload.length)` | `decodeOutputPayload` | 1 per decoded line; unavoidable (decoding can only shrink, so pre-alloc at input size is the right strategy) |
| `rawLine` subarray | `_collectLine` in tokenizer | 0 copies when the entire line arrives in a single `push` call (common case — tmux delivers lines in one chunk); multi-chunk arrival copies once |
| String allocation for keyword | `_extractKeyword` — char-by-char concat | 1 small JS string per line; GC pressure is low for short keywords ("output", ~6 chars) |
| Token object `{ kind, keyword, rawLine }` | `push` in tokenizer | 1 object per token; unavoidable at current API design |

**No per-byte allocation anywhere in the hot path.** The octal decoder works on a pre-allocated output buffer and returns a subarray view. The scrollback store appends by reference (no copy unless eviction kicks in).

### Key finding — `_extractKeyword` string building

`_extractKeyword` constructs the keyword string via `kw += String.fromCharCode(...)` inside a loop. This is idiomatic but creates a new string on each concatenation in older V8 (modern V8 rope-strings mitigate this). For "output" (6 chars) this is noise. A pre-keyed `Uint8Array` comparison could avoid the allocation entirely, but the gain is unmeasurable at current throughput.

### Key finding — `_collectLine` chunking cost

In the common case (each `push(chunk)` contains one or more complete `%output` lines), `_lineBuf` has exactly one entry and `_collectLine` returns the subarray directly (zero copy). The copy path activates only when a line straddles two `push` calls — rare for a firehose pane with large chunks.

### Key finding — `encodeFrame` (not in this path yet)

`encodeFrame` in `framing.ts` allocates `new Uint8Array(11 + idLen + payLen)` per frame. This module is called by the real socket transport (not by the in-memory transport used in testing). At 205 MB/s the frame allocations would be ~200 MB/s of `Uint8Array` churn — measurable, but within what V8's generational GC handles well. If frame encoding ever shows latency spikes, the fix is a pool or a scatter-gather write that avoids the allocation.

## Optimizations applied

None. The pipeline is already allocation-efficient at the hot-path level. All identified improvements are documented below as future opportunities; applying them would risk correctness without a measurable throughput benefit at current pane-output rates.

## Remaining opportunities

| Opportunity | Where | Expected gain | Notes |
|---|---|---|---|
| Reuse `Uint8Array` across `decodeOutputPayload` calls | `output-codec.ts` | Eliminates 1 alloc/line | Needs caller discipline (can't retain old result after next decode). API change: caller supplies output buffer. |
| Intern keyword lookup with Uint8Array comparison | `tokenizer.ts _extractKeyword` | Eliminates string allocs | Viable: compare bytes 1..end against known keywords "begin","end","error","output". Reduces GC pressure under very high notification rates. |
| `encodeFrame` scatter-gather | `framing.ts` | Eliminates 1 large alloc/frame on wire transport | Use `writev`-style writes (header separately from payload) when the transport supports it. No-op for in-memory transport. |
| Pre-allocated line buffer in tokenizer | `tokenizer.ts _lineBuf` | Minor: avoids array resize | Replace `Uint8Array[]` with a fixed-size preallocated ring; only relevant when lines span many chunks. |

## Correctness

All 720 tests pass (715 pre-existing + 5 new benchmark assertions). No hot-path source files were modified.
