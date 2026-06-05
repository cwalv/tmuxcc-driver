/**
 * dependency-cruiser configuration for tmuxcc-broker.
 *
 * Enforces the polyrepo boundary invariant:
 *
 *   broker-no-daemon-runtime: broker/src/ must not import @tmuxcc/daemon
 *   internal sub-paths (e.g. @tmuxcc/daemon/src/runtime/…). Only the
 *   package barrel (@tmuxcc/daemon) is allowed.
 *
 * Rationale: @tmuxcc/daemon barrel is the stable contract seam.
 * Importing internal sub-paths bypasses the exports map and creates
 * invisible coupling to daemon internals.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "broker-no-daemon-runtime",
      comment:
        "broker/src/ must only import from the @tmuxcc/daemon barrel. " +
        "Sub-path imports like @tmuxcc/daemon/src/runtime/… bypass the " +
        "exports map and couple the broker to daemon internals.",
      severity: "error",
      from: { path: "^src/" },
      to: {
        path: "@tmuxcc/daemon/src/",
      },
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
