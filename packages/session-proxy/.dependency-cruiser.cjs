/**
 * dependency-cruiser configuration for tmuxcc-daemon.
 *
 * Enforces two boundary invariants:
 *
 *   1. parser-no-wire: src/parser/ must NOT import from src/wire/
 *
 *      Parser is a pure south-facing decoder (byte streams → events).
 *      Wire is north-facing (protocol framing, transport).  Coupling parser to
 *      wire would invert the dependency direction and couple decoding to
 *      transport.
 *
 *   2. command-seam-no-host (tc-3si.1): src/runtime/ modules that issue tmux
 *      commands MUST go through the pipeline's atomic `send`/`sendBatch` seam
 *      and may NOT import `runtime/tmux-host.js` directly.
 *
 *      Background: the CommandCorrelator binds tmux's `%begin/%end` reply
 *      blocks to outstanding command slots in FIFO write order. A slot-less
 *      `host.write` mis-binds whenever any other writer (notably the requery
 *      engine's `list-windows`/`list-panes` pair) has registered a slot in the
 *      meantime — the engine's topology snapshot is then parsed from another
 *      command's reply bytes, producing garbled commits (tc-128.4, flow-load
 *      F4 garbage commit; tc-e3m flakes).
 *
 *      The fix is structural: `pipeline.send(cmd)` registers the slot and
 *      writes atomically. Any module that needs to issue tmux commands takes
 *      `send`/`sendBatch` callbacks instead of a `TmuxHost`. This rule
 *      enforces that input-path.ts, flow-control.ts, and other downstream
 *      runtime modules cannot reach for `tmux-host` directly — the temptation
 *      to call `host.write(cmd)` is removed at the import boundary.
 *
 *      Modules allowed to import tmux-host.js:
 *       - tmux-host.ts itself (re-exports its own types in test files)
 *       - pipeline.ts (the seam — owns the correlator + host.write)
 *       - session-proxy.ts (constructs the host and threads it to pipeline)
 *       - index.ts / runtime/index.ts (barrel re-exports for downstream
 *         consumers that need the TmuxHost TYPE)
 *       - *.test.ts (test scaffolding may stub the TmuxHost interface)
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "parser-no-wire",
      comment:
        "src/parser/ must not import from src/wire/ — parser is south-facing " +
        "(byte streams → events); wire is north-facing (protocol framing).",
      severity: "error",
      from: { path: "^src/parser/" },
      to: { path: "^src/wire/" },
    },
    {
      name: "command-seam-no-host",
      comment:
        "Runtime modules outside the command seam must NOT import " +
        "runtime/tmux-host (tc-3si.1). The atomic `pipeline.send` / " +
        "`pipeline.sendBatch` callbacks are the only legal way to emit a " +
        "tmux command; importing tmux-host directly invites the slot-less " +
        "`host.write(cmd)` shape that mis-binds %end replies under requery " +
        "traffic. The seam is: pipeline.ts + session-proxy.ts (+ index " +
        "barrels for TYPE re-exports). Downstream modules take `send` / " +
        "`sendBatch` callbacks instead.",
      severity: "error",
      from: {
        path: "^src/runtime/",
        pathNot: [
          "^src/runtime/tmux-host\\.ts$",
          "^src/runtime/pipeline\\.ts$",
          "^src/runtime/session-proxy\\.ts$",
          "^src/runtime/index\\.ts$",
          "\\.test\\.ts$",
        ],
      },
      to: { path: "^src/runtime/tmux-host\\.ts$" },
    },
  ],
  options: {
    moduleSystems: ["es6", "cjs"],
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".js", ".mts", ".mjs"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
