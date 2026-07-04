/**
 * freeze-roundtrip.test.ts — real-tmux behavioral coverage for the tc-gjdx.5
 * session freeze + round-trip.
 *
 * Acceptance criteria tested here:
 *   R1. Managed (strip-shaped, 2-pane hsplit) session: freeze → schema-valid
 *       template → apply → topology/geometry match.
 *   R2. Wild (nested vsplit→hsplit) session: freeze → schema-valid template →
 *       apply → topology/geometry match.
 *   R3. The frozen template's frozenTemplate field appears in the
 *       session.freezeTemplate command response.
 *   R4. Single-pane session freeze round-trips.
 *
 * Harness: each test spins up its own broker on a unique `-L` socket + private
 * runtime dir, tmux-guarded, runs under serialised real-tmux concurrency.
 *
 * @module freeze-roundtrip.test
 */
export {};
//# sourceMappingURL=freeze-roundtrip.test.d.ts.map