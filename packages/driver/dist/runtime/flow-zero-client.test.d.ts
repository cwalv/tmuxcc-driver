/**
 * tc-76m8.32 — zero-client flood must not wedge the pane (real tmux).
 *
 * # The bug this file pins
 *
 * After the LAST client detaches (or before the first ever attaches), pane
 * output kept flowing through the accounting store into the flow controller.
 * The controller fanned those bytes into the implicit DEFAULT_CLIENT
 * sub-ledger — a ledger NO transport ever drains (production only credits
 * `noteDrained` from a real client's draining wrapper). A pane that flooded
 * past HIGH_WATER during such a zero-client interval was paused and could
 * NEVER resume: the resume edge needs the MAX over sub-ledgers to fall to
 * LOW_WATER, and the stale DEFAULT_CLIENT entry pinned it above forever —
 * even after a new client attached (a fresh client starts at 0 and its
 * credits debit only its own sub-ledger). Permanent frozen pane; continuity
 * broken (tmux held/aged the output the store should have mirrored).
 *
 * The fix (FC-6, flow-control.ts): the ledger's keys are exactly the
 * registered client set. With zero registered clients `onPaneBytes` accounts
 * nothing and backpressure never engages — the bytes are owed to no
 * transport (FC-4's sense), and the capped scrollback store keeps mirroring
 * the pane for reattach hydration.
 *
 * # Coverage
 *
 *   Z1. Full production path: attach a client, detach it, flood the pane
 *       during the zero-client interval (well past HIGH_WATER), reattach a
 *       fresh client. The pane must NOT be backpressure-paused, the ledger
 *       must not be pinned, and a post-reattach marker round-trip must reach
 *       the new client (the demux gate is genuinely open).
 *
 * @module runtime/flow-zero-client.test
 */
export {};
//# sourceMappingURL=flow-zero-client.test.d.ts.map