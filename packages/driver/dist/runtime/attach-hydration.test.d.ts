/**
 * tc-295a.8 / tc-295a.9 — SP-level attach + hydration ordering tests.
 *
 * These exercise the COMPOSITION that `session-proxy.ts` wires up
 * (`makeSentinels` + `attachAndHydratePane`) using the same exported primitives
 * — `hydratePane` / `hydrateTransport` (hydration.ts) and the real
 * `createOutputDemux` queue gate — plus a minimal fake of the ControlServer's
 * `sendDirected` seq-stamping. The full createSessionProxy assembly always
 * builds its own real TmuxHost, so reconstructing the orchestration here lets us
 * assert the WIRE CONTRACT deterministically without spawning tmux.
 *
 * The pieces under test are the durable part (the bead notes tc-2x3.3 will
 * re-touch the impl): the message shapes + the ordering guarantee.
 *
 * Coverage (the ACs the bead names):
 *   1. attach-to-vanished-pane → pane.attach.failed{pane.not-found} (no
 *      hydration sentinels, no data frame).
 *   2. attach-to-live-pane → pane.hydration.begin → (clear+replay frame) →
 *      pane.hydration.end, in that order.
 *   3. live-bytes-during-hydration are QUEUED and replayed AFTER the clear+
 *      replay frame and BEFORE pane.hydration.end's effect — no interleave.
 *
 * @module runtime/attach-hydration.test
 */
export {};
//# sourceMappingURL=attach-hydration.test.d.ts.map