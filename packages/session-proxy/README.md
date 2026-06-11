# tmuxcc-daemon

Per-session bridge between `tmux -CC` (control mode) and the language-neutral
session-proxy wire. One session-proxy process is bound to exactly one tmux session for its
lifetime; lifecycle and discovery are owned by the **serverProxy (server-proxy)**
(see `SCHEMA.md` for the server-proxy spec).

The session-proxy is a **stateless translation layer** — every value it holds
(parser state, layout reducer, snapshot, client transports) is derivable
from tmux on a fresh `-CC attach`.  Tmux is the only persistence layer in
the system; this session-proxy is a view of one of tmux's sessions.  See
`projects/tmuxcc/docs/ext-a-design-context.md` Part 6 for the full
component-lifetime model.  The intended new name is **`session-proxy`**;
`session-proxy` is retained in code pending rename.

**Modules (single-consumer, kept internal — not separate repos):**
- `-CC` parser: control-mode stream → typed events; command serializer.
  Emits **raw bytes** for `%output` (octal-unescaped; never assumes UTF-8).
- state reducer: events → windows / panes + layout-string parser. The session-proxy
  owns canonical model state for its bound session.
- I/O / demux: per-pane streams out; input muxed back in as `send-keys -H`.

**Wires (a spec, not a repo):** `SCHEMA.md` defines two wires — the
per-session **session-proxy wire** owned by this process, and the per-socket
**server-proxy wire** owned by the server-proxy. Both wires speak panes / bytes /
deltas / input / resize / session-metadata — **never** `%output`, never
`Pseudoterminal`. Wires graduate to a neutral repo (`.proto` + bindings)
only when a second-language server actually exists.

Part of the `tmuxcc` repoweave project.

## Architecture position

```
[ tmux server (one socket) ]
       ↕
[ serverProxy (server-proxy) ]   ← discovery + lifecycle; this session-proxy's parent
       ↓ spawns
[ this sessionProxy ]      ← attached to ONE tmux session via -CC attach -t <name>
       ↕ session-proxy wire
[ client ]
```

SessionProxys are spawned by the server-proxy on `session.claim`. A session-proxy never
discovers sessions on its own and never creates or destroys them.

## Lifetime

SessionProxys are spawned as regular (non-detached) child processes of the
server-proxy and **explicitly enforce** die-with-parent — process-group
mechanics alone do not deliver it (a SIGKILLed parent's children are
reparented to init, not signalled).  Mechanism: on Linux the session-proxy
installs `prctl(PR_SET_PDEATHSIG, SIGTERM)` at startup; on macOS it polls
`getppid()` every 1 s and exits when reparented to launchd (ppid 1).
When the server-proxy dies (clean exit, crash, SIGKILL), all session-proxies die with
it.  There is **no** orphan-and-reclaim mechanism.

Recovery from server-proxy death is therefore: client launcher detects no server-proxy
→ spawns a fresh server-proxy → fresh server-proxy discovers tmux sessions → spawns
fresh session-proxies on next `session.claim` → fresh `-CC attach` to each
surviving tmux session.  No session-proxy state is lost in this path because the
session-proxy never held any state worth preserving — tmux is the truth.

Additional exit triggers besides parent death:

- The bound session goes away (`%session-changed` to another session or
  `kill-session`).  The session-proxy emits an
  `ErrorMessage{code:"session.unavailable"}`, closes its client
  transports, and exits.  The server-proxy reaps the entry.
- The server-proxy explicitly reaps the sessionProxy (e.g. user-initiated
  `kill-session`).

If the session-proxy crashes while the server-proxy survives, the server-proxy reaps the
registry entry and re-spawns a fresh session-proxy on the next `session.claim`
for the same session — no client-visible state is lost (tmux is the
truth).

## Socket conventions

Each session-proxy listens on its own unix socket. The server-proxy mints the socket
path when it spawns the session-proxy and hands it to the client via
`session.claim` / `session.create`. SessionProxy socket paths are an
implementation detail of the serverProxy; clients treat them as opaque
endpoint strings.

Under the v3 trust model (see `SCHEMA.md` — "Trust and security model"),
server-proxy and session-proxy sockets live in `$XDG_RUNTIME_DIR/tmuxcc/` (falling
back to `/tmp/tmuxcc-<uid>/`), with the directory at mode 0700 and the
socket files at mode 0600. There is no cryptographic authentication;
any local process the kernel grants socket access is trusted.

The **tmux** socket (where `tmux -CC attach` connects) is owned by the
server-proxy. Test server-proxies use `tmuxcc-test-<id>` socket names; production
server-proxies use `tmuxcc`. Socket naming is a single server-proxy constructor
argument with no env-var threading.
