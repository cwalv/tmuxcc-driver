/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "parser-no-protocol",
      comment:
        "src/parser/ must not import from @tmuxcc/protocol — parser is south-facing " +
        "(byte streams → events); protocol is north-facing (framing).",
      severity: "error",
      from: { path: "^src/parser/" },
      to: { path: "@tmuxcc/protocol" },
    },
    {
      name: "command-seam-no-host",
      comment:
        "Runtime modules outside the command seam must NOT import " +
        "runtime/tmux-host (tc-3si.1).",
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
