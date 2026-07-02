/**
 * Structured layout representation for the tmuxcc wire protocol.
 *
 * The session-proxy parses tmux's south-side layout strings (e.g.
 * "5x24,0,0[5x12,0,0,0,5x12,0,12,1]") and converts them into this
 * transport-agnostic tree. The wire carries the structured tree; layout
 * strings never appear on the wire.
 *
 * Design: recursive split tree with typed nodes. Two kinds of internal nodes
 * (horizontal / vertical splits) and one leaf (pane). Sizes are always in
 * terminal cells (columns × rows).
 */
export {};
//# sourceMappingURL=layout.js.map