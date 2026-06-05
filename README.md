# tmuxcc-client

Headless brains shared by every front-end (the VS Code extension and, later,
the web UI). Consumes the daemon's wire, holds session state for rendering,
and exposes render hooks.

**No DOM, no host API, no tmux vocabulary.** This is the genuinely-shared
piece that makes "one core, two renderers" real — it never speaks `-CC` and
never knows whether it's driving `Pseudoterminal` terminals or xterm.js.

Depends on the wire contract defined in `tmuxcc-daemon`. Wire protocol
reference: `tmuxcc-daemon/SCHEMA.md`.

Part of the `tmuxcc` repoweave project.

## Shape (v3 — single-session)

`Mirror` is single-session: one `Mirror` instance tracks the state of one
tmux session on one daemon-wire connection. `RenderHook` callbacks carry
`paneId` and `windowId` but no `sessionId` — the session is always the
bound session. Clients that need multi-session discovery connect to the
broker first (`@tmuxcc/broker`) and maintain one `Mirror` per claimed session.
