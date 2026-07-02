/**
 * Tests for the per-pane scrollback byte-buffer store (tc-fx2).
 *
 * All tests use node:test + node:assert/strict.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createPaneBufferStore, DEFAULT_CAP_BYTES } from "./scrollback.js";
import { paneId } from "@tmuxcc/protocol";

const PA = paneId("p-a");
const PB = paneId("p-b");
const PC = paneId("p-c");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPaneBufferStore", () => {
  // -------------------------------------------------------------------------
  // 1. Append then getContents — byte-exact round-trip
  // -------------------------------------------------------------------------
  describe("append / getContents round-trip", () => {
    it("returns empty Uint8Array for unknown pane", () => {
      const store = createPaneBufferStore();
      const contents = store.getContents(PA);
      assert.equal(contents.length, 0);
    });

    it("round-trips a simple ASCII payload", () => {
      const store = createPaneBufferStore();
      const payload = bytes(72, 101, 108, 108, 111); // "Hello"
      store.append(PA, payload);
      const got = store.getContents(PA);
      assert.deepEqual(got, payload);
    });

    it("round-trips a non-UTF-8 payload (0xff 0x00 0xfe)", () => {
      const store = createPaneBufferStore();
      const payload = bytes(0xff, 0x00, 0xfe);
      store.append(PA, payload);
      const got = store.getContents(PA);
      assert.deepEqual(got, payload);
    });

    it("round-trips multiple appends concatenated in order", () => {
      const store = createPaneBufferStore();
      const a = bytes(0x01, 0x02);
      const b = bytes(0x03, 0x04);
      const c = bytes(0x05);
      store.append(PA, a);
      store.append(PA, b);
      store.append(PA, c);
      const got = store.getContents(PA);
      assert.deepEqual(got, concat(a, b, c));
    });

    it("getContents returns a copy — mutating the result does not affect the store", () => {
      const store = createPaneBufferStore();
      store.append(PA, bytes(0xaa, 0xbb));
      const got = store.getContents(PA);
      // Mutate the returned copy.
      got[0] = 0x00;
      // Store should be unaffected.
      assert.deepEqual(store.getContents(PA), bytes(0xaa, 0xbb));
    });
  });

  // -------------------------------------------------------------------------
  // 2. Cap eviction — byte-accurate
  // -------------------------------------------------------------------------
  describe("cap eviction", () => {
    it("retains exactly capBytes after exceeding the cap (whole-chunk boundary)", () => {
      // capBytes = 5; append 3 bytes then 5 bytes → total 8 → evict first 3.
      const store = createPaneBufferStore({ capBytes: 5 });
      store.append(PA, bytes(0x01, 0x02, 0x03)); // 3 bytes
      store.append(PA, bytes(0x04, 0x05, 0x06, 0x07, 0x08)); // 5 bytes → total 8
      const got = store.getContents(PA);
      // Should keep the most recent 5 bytes: 0x04…0x08
      assert.deepEqual(got, bytes(0x04, 0x05, 0x06, 0x07, 0x08));
      assert.equal(store.size(PA), 5);
    });

    it("evicts byte-accurately when boundary falls mid-chunk", () => {
      // capBytes = 4; append 7-byte chunk → total 7 → must evict 3 bytes from
      // the front of that single chunk, keeping [0x04,0x05,0x06,0x07].
      const store = createPaneBufferStore({ capBytes: 4 });
      store.append(PA, bytes(0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07));
      const got = store.getContents(PA);
      assert.deepEqual(got, bytes(0x04, 0x05, 0x06, 0x07));
      assert.equal(store.size(PA), 4);
    });

    it("keeps only the most-recent capBytes across many appends", () => {
      // capBytes = 3; append 10 single bytes one by one.
      const store = createPaneBufferStore({ capBytes: 3 });
      for (let i = 1; i <= 10; i++) {
        store.append(PA, bytes(i));
      }
      // Last 3 bytes: 8, 9, 10
      assert.deepEqual(store.getContents(PA), bytes(8, 9, 10));
      assert.equal(store.size(PA), 3);
    });

    it("capBytes=0 retains nothing", () => {
      const store = createPaneBufferStore({ capBytes: 0 });
      store.append(PA, bytes(0x01, 0x02, 0x03));
      assert.equal(store.size(PA), 0);
      assert.equal(store.getContents(PA).length, 0);
    });

    it("large append that exactly fills the cap retains all bytes", () => {
      const store = createPaneBufferStore({ capBytes: 4 });
      store.append(PA, bytes(0xaa, 0xbb, 0xcc, 0xdd)); // exactly 4
      assert.deepEqual(store.getContents(PA), bytes(0xaa, 0xbb, 0xcc, 0xdd));
      assert.equal(store.size(PA), 4);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Multiple panes isolated
  // -------------------------------------------------------------------------
  describe("pane isolation", () => {
    it("appending to pane A does not affect pane B", () => {
      const store = createPaneBufferStore();
      store.append(PA, bytes(0x01, 0x02));
      store.append(PB, bytes(0x03, 0x04));
      assert.deepEqual(store.getContents(PA), bytes(0x01, 0x02));
      assert.deepEqual(store.getContents(PB), bytes(0x03, 0x04));
    });

    it("eviction in pane A does not evict pane B", () => {
      const store = createPaneBufferStore({ capBytes: 2 });
      store.append(PA, bytes(0xaa, 0xbb, 0xcc)); // eviction in A
      store.append(PB, bytes(0x01, 0x02)); // B fits fine
      // A keeps only last 2 bytes
      assert.deepEqual(store.getContents(PA), bytes(0xbb, 0xcc));
      // B untouched
      assert.deepEqual(store.getContents(PB), bytes(0x01, 0x02));
    });

    it("three independent panes", () => {
      const store = createPaneBufferStore();
      store.append(PA, bytes(1));
      store.append(PB, bytes(2));
      store.append(PC, bytes(3));
      store.append(PA, bytes(4));
      assert.deepEqual(store.getContents(PA), bytes(1, 4));
      assert.deepEqual(store.getContents(PB), bytes(2));
      assert.deepEqual(store.getContents(PC), bytes(3));
    });
  });

  // -------------------------------------------------------------------------
  // 4. drop() — removes a pane's buffer
  // -------------------------------------------------------------------------
  describe("drop", () => {
    it("drop removes the buffer; size → 0, getContents → empty", () => {
      const store = createPaneBufferStore();
      store.append(PA, bytes(0x01, 0x02, 0x03));
      store.drop(PA);
      assert.equal(store.size(PA), 0);
      assert.equal(store.getContents(PA).length, 0);
    });

    it("drop of an unknown pane is a no-op", () => {
      const store = createPaneBufferStore();
      assert.doesNotThrow(() => store.drop(PA));
    });

    it("drop does not affect other panes", () => {
      const store = createPaneBufferStore();
      store.append(PA, bytes(0xaa));
      store.append(PB, bytes(0xbb));
      store.drop(PA);
      assert.deepEqual(store.getContents(PB), bytes(0xbb));
    });

    it("can re-append to a pane after dropping it", () => {
      const store = createPaneBufferStore();
      store.append(PA, bytes(0x01));
      store.drop(PA);
      store.append(PA, bytes(0x02));
      assert.deepEqual(store.getContents(PA), bytes(0x02));
    });
  });

  // -------------------------------------------------------------------------
  // 5. "Survives resize" — resize is a no-op on the buffer store
  // -------------------------------------------------------------------------
  describe("survives resize", () => {
    it("append, simulate resize (no-op on buffer), append more → full continuity", () => {
      const store = createPaneBufferStore();

      const before = bytes(0x10, 0x11, 0x12);
      store.append(PA, before);

      // Resize is handled by the model/renderer, NOT the buffer store.
      // We simulate it here as a no-op to confirm the store doesn't need to
      // know about it. (The reducer would call updatePane for cols/rows.)
      // No buffer call at all — just continue appending.

      const after = bytes(0x13, 0x14);
      store.append(PA, after);

      assert.deepEqual(store.getContents(PA), concat(before, after));
      assert.equal(store.size(PA), 5);
    });

    it("resize does not lose data across cap boundary", () => {
      const store = createPaneBufferStore({ capBytes: 4 });
      store.append(PA, bytes(0x01, 0x02, 0x03)); // 3 bytes
      // (resize would happen here — no store call)
      store.append(PA, bytes(0x04, 0x05)); // now 5 bytes total → evict 1 byte
      // Keeps last 4: 0x02 0x03 0x04 0x05
      assert.deepEqual(store.getContents(PA), bytes(0x02, 0x03, 0x04, 0x05));
    });
  });

  // -------------------------------------------------------------------------
  // 6. size() — accurate before and after eviction
  // -------------------------------------------------------------------------
  describe("size", () => {
    it("size is 0 for unknown pane", () => {
      const store = createPaneBufferStore();
      assert.equal(store.size(PA), 0);
    });

    it("size tracks total bytes before eviction", () => {
      const store = createPaneBufferStore({ capBytes: 1000 });
      store.append(PA, bytes(0x01, 0x02, 0x03));
      assert.equal(store.size(PA), 3);
      store.append(PA, bytes(0x04, 0x05));
      assert.equal(store.size(PA), 5);
    });

    it("size equals capBytes after eviction", () => {
      const store = createPaneBufferStore({ capBytes: 3 });
      store.append(PA, bytes(0x01, 0x02, 0x03, 0x04, 0x05));
      assert.equal(store.size(PA), 3);
    });

    it("size is 0 after drop", () => {
      const store = createPaneBufferStore();
      store.append(PA, bytes(0xff));
      store.drop(PA);
      assert.equal(store.size(PA), 0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. clear() — reset all buffers
  // -------------------------------------------------------------------------
  describe("clear", () => {
    it("clear removes all pane buffers", () => {
      const store = createPaneBufferStore();
      store.append(PA, bytes(0x01));
      store.append(PB, bytes(0x02));
      store.clear();
      assert.equal(store.size(PA), 0);
      assert.equal(store.size(PB), 0);
      assert.equal(store.getContents(PA).length, 0);
      assert.equal(store.getContents(PB).length, 0);
    });

    it("can append to panes after clear", () => {
      const store = createPaneBufferStore();
      store.append(PA, bytes(0xaa));
      store.clear();
      store.append(PA, bytes(0xbb));
      assert.deepEqual(store.getContents(PA), bytes(0xbb));
    });
  });

  // -------------------------------------------------------------------------
  // 8. Default cap sanity check
  // -------------------------------------------------------------------------
  describe("default cap", () => {
    it("DEFAULT_CAP_BYTES is 1 MiB", () => {
      assert.equal(DEFAULT_CAP_BYTES, 1_048_576);
    });

    it("store with default cap retains up to 1 MiB", () => {
      const store = createPaneBufferStore();
      // Append exactly 1 MiB — should be retained in full.
      const chunk = new Uint8Array(DEFAULT_CAP_BYTES).fill(0xab);
      store.append(PA, chunk);
      assert.equal(store.size(PA), DEFAULT_CAP_BYTES);
    });

    it("store with default cap evicts when over 1 MiB", () => {
      const store = createPaneBufferStore();
      const chunk1 = new Uint8Array(DEFAULT_CAP_BYTES).fill(0x01);
      const chunk2 = new Uint8Array(100).fill(0x02); // push 100 bytes over cap
      store.append(PA, chunk1);
      store.append(PA, chunk2);
      // Total should be exactly capBytes
      assert.equal(store.size(PA), DEFAULT_CAP_BYTES);
      // Most recent 100 bytes should be 0x02
      const contents = store.getContents(PA);
      const tail = contents.subarray(contents.length - 100);
      assert.deepEqual(tail, chunk2);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Appending empty Uint8Array is a no-op
  // -------------------------------------------------------------------------
  describe("empty append", () => {
    it("appending empty bytes does not create a buffer", () => {
      const store = createPaneBufferStore();
      store.append(PA, new Uint8Array(0));
      assert.equal(store.size(PA), 0);
    });

    it("appending empty bytes to existing buffer changes nothing", () => {
      const store = createPaneBufferStore();
      store.append(PA, bytes(0x01));
      store.append(PA, new Uint8Array(0));
      assert.equal(store.size(PA), 1);
      assert.deepEqual(store.getContents(PA), bytes(0x01));
    });
  });
});
