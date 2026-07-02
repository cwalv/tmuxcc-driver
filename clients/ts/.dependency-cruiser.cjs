/**
 * dependency-cruiser configuration for tmuxcc-client.
 *
 * Enforces the polyrepo boundary invariant:
 *
 *   client-no-driver-runtime: client/src/ must not import @tmuxcc/protocol or
 *   @tmuxcc/driver internal sub-paths (e.g. @tmuxcc/driver/src/runtime/…). Only
 *   the package barrels (@tmuxcc/protocol, @tmuxcc/driver) are allowed.
 *
 * Rationale: the package barrels are the stable contract seam. Importing
 * internal sub-paths bypasses the package's exports map, creates invisible
 * coupling to driver internals, and can pull in Node-only runtime modules
 * (child_process, pty, etc.) into the client bundle.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "client-no-driver-runtime",
      comment:
        "client/src/ must only import from the @tmuxcc/protocol and @tmuxcc/driver " +
        "barrels. Sub-path imports like @tmuxcc/driver/src/runtime/… bypass the " +
        "exports map and couple the client to driver internals.",
      severity: "error",
      from: { path: "^src/" },
      to: {
        // Match any import whose module specifier (or resolved path) contains
        // "@tmuxcc/protocol/src/" or "@tmuxcc/driver/src/". The packages only
        // export "."; any sub-path import like "@tmuxcc/driver/src/runtime/..."
        // is NOT listed in the exports map, so depcruise leaves the resolved
        // field as the raw module specifier — still matching this pattern.
        path: "@tmuxcc/(protocol|driver)/src/",
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
