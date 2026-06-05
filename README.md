# tmuxcc-daemon

Per-session bridge between `tmux -CC` (control mode) and the language-neutral
daemon wire. One daemon process is bound to exactly one tmux session for its
lifetime; lifecycle and discovery are owned by a sibling **session broker**
(see `SCHEMA.md` for the broker spec).

**Modules (single-consumer, kept internal — not separate repos):**
- `-CC` parser: control-mode stream → typed events; command serializer.
  Emits **raw bytes** for `%output` (octal-unescaped; never assumes UTF-8).
- state reducer: events → windows / panes + layout-string parser. The daemon
  owns canonical model state for its bound session.
- I/O / demux: per-pane streams out; input remuxed as `send-keys -H`.

**Wires (a spec, not a repo):** `SCHEMA.md` defines two wires — the
per-session **daemon wire** owned by this process, and the per-socket
**broker wire** owned by the broker. Both wires speak panes / bytes /
deltas / input / resize / session-metadata — **never** `%output`, never
`Pseudoterminal`. Wires graduate to a neutral repo (`.proto` + bindings)
only when a second-language server actually exists.

Part of the `tmuxcc` repoweave project.

## Architecture position

```
[ tmux server (one socket) ]
       ↕
[ session broker ]   ← discovery + lifecycle; this daemon's parent
       ↓ spawns
[ this daemon ]      ← attached to ONE tmux session via -CC attach -t <name>
       ↕ daemon wire
[ client ]
```

Daemons are spawned by the broker on `session.claim`. A daemon never
discovers sessions on its own and never creates or destroys them. If its
bound session goes away (`%session-changed` to another session or
`kill-session`), the daemon emits an `ErrorMessage{code:"session.unavailable"}`
and closes its connections; the broker reaps it.

## Socket conventions

Each daemon listens on its own unix socket. The broker mints the socket
path when it spawns the daemon and hands it to the client via
`session.claim` / `session.create`. Daemon socket paths are an
implementation detail of the broker; clients treat them as opaque
endpoint strings.

Under the v3 trust model (see `SCHEMA.md` — "Trust and security model"),
broker and daemon sockets live in `$XDG_RUNTIME_DIR/tmuxcc/` (falling
back to `/tmp/tmuxcc-<uid>/`), with the directory at mode 0700 and the
socket files at mode 0600. There is no cryptographic authentication;
any local process the kernel grants socket access is trusted.

The **tmux** socket (where `tmux -CC attach` connects) is owned by the
broker. Test brokers use `tmuxcc-test-<id>` socket names; production
brokers use `tmuxcc`. Socket naming is a single broker constructor
argument with no env-var threading.
