/**
 * dependency-cruiser configuration for tmuxcc-daemon.
 *
 * Enforces the polyrepo boundary invariant:
 *
 *   parser-no-wire: src/parser/ must NOT import from src/wire/
 *
 * Rationale: parser is a pure south-facing decoder (byte streams → events).
 * Wire is north-facing (protocol framing, transport).  Coupling parser to
 * wire would invert the dependency direction and couple decoding to transport.
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
