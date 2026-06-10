/**
 * dependency-cruiser configuration for tmuxcc-client.
 *
 * Enforces the polyrepo boundary invariant:
 *
 *   client-no-daemon-runtime: client/src/ must not import @tmuxcc/daemon
 *   internal sub-paths (e.g. @tmuxcc/daemon/src/runtime/…).  Only the
 *   package barrel (@tmuxcc/daemon) is allowed.
 *
 * Rationale: the @tmuxcc/daemon package barrel is the stable contract seam.
 * Importing internal sub-paths bypasses the package's exports map, creates
 * invisible coupling to daemon internals, and can pull in Node-only runtime
 * modules (child_process, pty, etc.) into the client bundle.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "client-no-daemon-runtime",
      comment:
        "client/src/ must only import from the @tmuxcc/daemon barrel. " +
        "Sub-path imports like @tmuxcc/daemon/src/runtime/… bypass the " +
        "exports map and couple the client to daemon internals.",
      severity: "error",
      from: { path: "^src/" },
      to: {
        // Match any import whose module specifier (or resolved path) contains
        // "@tmuxcc/daemon/src/".  The daemon's package.json only exports ".";
        // any sub-path import like "@tmuxcc/daemon/src/runtime/..." is NOT
        // listed in the exports map, so depcruise leaves the resolved field as
        // the raw module specifier — still matching this pattern.
        path: "@tmuxcc/daemon/src/",
      },
    },
  ],
  options: {
    moduleSystems: ["es6", "cjs"],
    // tsPreCompilationDeps is required so that depcruise follows TypeScript
    // imports before compilation and can resolve workspace packages to their
    // actual source files, revealing sub-path imports that bypass the barrel.
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
