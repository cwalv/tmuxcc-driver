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

## Test socket convention (tc-bpn)

Every test-owned tmux socket MUST use the shape:

```
tmuxcc-test-<pid>-<suffix>
```

where `<pid>` is `process.pid` of the test-runner process that mints it (e.g.
`tmuxcc-test-${process.pid}-e2e-${Date.now()}-smoke`).

**Why:** `src/runtime/test-tmux-cleanup.ts` runs a boot sweep on first use that
reaps any `tmuxcc-test-*` sockets whose owner PID is no longer alive. The PID
segment lets the sweep distinguish orphans from sockets in active use by a
concurrent test agent. Names not matching `/^tmuxcc-test-\d+-/` are rejected
by `trackSocket()` at runtime.

Production socket names (`tmuxcc-vscode-<pid>-<ts>`, bare `tmuxcc`, user's
`-L default`) are all outside the `tmuxcc-test-` prefix and are never touched
by the sweep.
