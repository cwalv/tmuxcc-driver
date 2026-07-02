/**
 * Tests for the in-memory transport pair (src/wire/transport.ts).
 *
 * These tests exercise the Transport seam without any real socket or pipe:
 *   1. Control-plane round-trip: a ControlMessage sent on one endpoint
 *      arrives byte-identical on the other.
 *   2. Data-plane round-trip: raw bytes (including non-UTF-8 sequences)
 *      sent on one endpoint arrive byte-identical on the other.
 *   3. Close propagation: closing one endpoint notifies the other's onClose
 *      handlers (multi-handler subscription, tc-b55u).
 */
export {};
//# sourceMappingURL=transport.test.d.ts.map