# tmuxcc-daemon

Owns the single `tmux -CC` (control mode) connection and serves a
language-neutral wire to clients.

**Modules (single-consumer, kept internal — not separate repos):**
- `-CC` parser: control-mode stream → typed events; command serializer.
  Emits **raw bytes** for `%output` (octal-unescaped; never assumes UTF-8).
- state reducer: events → sessions / windows / panes + layout-string parser.
  The daemon owns canonical session state.
- I/O / demux: per-pane streams out; input remuxed as `send-keys -H`.

**Wire (a spec, not a repo):** the daemon↔client contract lives here as
`SCHEMA.md` + exported TS types, because the daemon owns the model and the
wire is a projection of it. The contract speaks panes / bytes / deltas /
input / resize — **never** `%output`, never `Pseudoterminal`. Graduates to its
own neutral repo (`.proto` + bindings) only when a second-language server
(Go/Rust) actually exists.

Part of the `tmuxcc` repoweave project. Design:
`foundations/docs/tmuxcc/repo-decomposition.md`.
