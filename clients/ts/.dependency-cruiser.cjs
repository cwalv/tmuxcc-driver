/**
 * dependency-cruiser configuration for tmuxcc-client.
 *
 * Enforces the polyrepo boundary invariant:
 *
 *   client-no-session-proxy-runtime: client/src/ must not import @tmuxcc/session-proxy
 *   internal sub-paths (e.g. @tmuxcc/session-proxy/src/runtime/…).  Only the
 *   package barrel (@tmuxcc/session-proxy) is allowed.
 *
 * Rationale: the @tmuxcc/session-proxy package barrel is the stable contract seam.
 * Importing internal sub-paths bypasses the package's exports map, creates
 * invisible coupling to session-proxy internals, and can pull in Node-only runtime
 * modules (child_process, pty, etc.) into the client bundle.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "client-no-session-proxy-runtime",
      comment:
        "client/src/ must only import from the @tmuxcc/session-proxy barrel. " +
        "Sub-path imports like @tmuxcc/session-proxy/src/runtime/… bypass the " +
        "exports map and couple the client to session-proxy internals.",
      severity: "error",
      from: { path: "^src/" },
      to: {
        // Match any import whose module specifier (or resolved path) contains
        // "@tmuxcc/session-proxy/src/".  The session-proxy's package.json only exports ".";
        // any sub-path import like "@tmuxcc/session-proxy/src/runtime/..." is NOT
        // listed in the exports map, so depcruise leaves the resolved field as
        // the raw module specifier — still matching this pattern.
        path: "@tmuxcc/session-proxy/src/",
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
