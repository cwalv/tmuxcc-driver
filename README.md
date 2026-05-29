# tmuxcc-client

Headless brains shared by every front-end (the VS Code extension and, later,
the web UI). Consumes the daemon's wire, holds session state for rendering,
and exposes render hooks.

**No DOM, no host API, no tmux vocabulary.** This is the genuinely-shared
piece that makes "one core, two renderers" real — it never speaks `-CC` and
never knows whether it's driving `Pseudoterminal` terminals or xterm.js.

Depends on the wire contract defined in `tmuxcc-daemon`.

Part of the `tmuxcc` repoweave project. Design:
`foundations/docs/tmuxcc/repo-decomposition.md`.
