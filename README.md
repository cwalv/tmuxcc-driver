# tmuxcc-daemon

Per-session bridge between `tmux -CC` (control mode) and the language-neutral
daemon wire. One daemon process is bound to exactly one tmux session for its
lifetime; lifecycle and discovery are owned by the **broker (server-proxy)**
(see `SCHEMA.md` for the broker spec).

The daemon is a **stateless translation layer** — every value it holds
(parser state, layout reducer, snapshot, client transports) is derivable
from tmux on a fresh `-CC attach`.  Tmux is the only persistence layer in
the system; this daemon is a view of one of tmux's sessions.  See
`projects/tmuxcc/docs/ext-a-design-context.md` Part 6 for the full
component-lifetime model.  The intended new name is **`session-proxy`**;
`daemon` is retained in code pending rename.

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
[ broker (server-proxy) ]   ← discovery + lifecycle; this daemon's parent
       ↓ spawns
[ this daemon ]      ← attached to ONE tmux session via -CC attach -t <name>
       ↕ daemon wire
[ client ]
```

Daemons are spawned by the broker on `session.claim`. A daemon never
discovers sessions on its own and never creates or destroys them.

## Lifetime

Daemons are spawned as regular (non-detached) child processes of the
broker and **explicitly enforce** die-with-parent — process-group
mechanics alone do not deliver it (a SIGKILLed parent's children are
reparented to init, not signalled).  Mechanism: on Linux the daemon
installs `prctl(PR_SET_PDEATHSIG, SIGTERM)` at startup; on macOS it polls
`getppid()` every 1 s and exits when reparented to launchd (ppid 1).
When the broker dies (clean exit, crash, SIGKILL), all daemons die with
it.  There is **no** orphan-and-reclaim mechanism.

Recovery from broker death is therefore: client launcher detects no broker
→ spawns a fresh broker → fresh broker discovers tmux sessions → spawns
fresh daemons on next `session.claim` → fresh `-CC attach` to each
surviving tmux session.  No daemon state is lost in this path because the
daemon never held any state worth preserving — tmux is the truth.

Additional exit triggers besides parent death:

- The bound session goes away (`%session-changed` to another session or
  `kill-session`).  The daemon emits an
  `ErrorMessage{code:"session.unavailable"}`, closes its client
  transports, and exits.  The broker reaps the entry.
- The broker explicitly reaps the daemon (e.g. user-initiated
  `kill-session`).

If the daemon crashes while the broker survives, the broker reaps the
registry entry and re-spawns a fresh daemon on the next `session.claim`
for the same session — no client-visible state is lost (tmux is the
truth).

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
