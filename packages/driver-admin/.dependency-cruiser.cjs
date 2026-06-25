/**
 * dependency-cruiser configuration for @tmuxcc/driver-admin.
 *
 * driver-admin is the Node-only diagnostics seam that connects to the EXISTING
 * server-proxy / session-proxy unix sockets and correlates a request.  It sits
 * ABOVE @tmuxcc/{server-proxy,session-proxy,client} and depends on all three —
 * but only at their PACKAGE BARRELS.  Sub-path imports (e.g.
 * @tmuxcc/server-proxy/src/runtime/…) bypass the exports map, couple this
 * package to driver internals, and defeat the contract seam.  Forbid them.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "driver-admin-no-subpath-imports",
      comment:
        "driver-admin/src/ must only import from the @tmuxcc/* package barrels. " +
        "Sub-path imports like @tmuxcc/server-proxy/src/… bypass the exports map " +
        "and couple driver-admin to driver internals.",
      severity: "error",
      from: { path: "^src/" },
      to: {
        path: "@tmuxcc/(server-proxy|session-proxy|client)/src/",
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
