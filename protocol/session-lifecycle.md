# Session Lifecycle: Cross-Stream Ordering Contract

**Bead:** tc-295a.6 (W1.5 — B4b+B1c)
**Status:** normative
**Applies to:** broker (server-proxy) ↔ client wire protocol

---

## Overview

The broker manages two stream channels per connected client:

- **C1** — the persistent broker keepalive stream (unix socket to the server-proxy).
  Carries `sessions.snapshot`, `sessions.added`, `sessions.removed`, and
  `sessions.renamed` messages.

- **C4** — the per-session data/control stream (per-session UDS to a session-proxy
  child process). Carries pane output, topology deltas, and session-scoped commands.

This document specifies the ordering contract that governs how C1 session-removal
events relate to the C4 connection close.

---

## The Contract

### C1. `sessions.removed` fires only on true tmux session drop

The broker emits `sessions.removed` only when `tmux list-sessions` confirms the
session is absent from the tmux server. Transient `list-sessions` failures (exit
non-zero, timeout, spawn error) leave the session table intact — no spurious removal
is emitted.

**Implementation reference:**  
`packages/server-proxy/src/server-proxy.ts` — `_refreshSessions()`: the
`listSessions` null-guard at the top of the function; session removal only on
absent tmuxId.

### C2. `sessions.removed` → C4 close ordering

When the broker broadcasts `sessions.removed` for a session:

1. **Synchronously** (in the same event-loop turn): `reapSessionProxy(sessionId)` is
   called on the supervisor, which immediately deletes the registry entry and sends
   `SIGTERM` to the session-proxy child process.
2. **Then** (same synchronous turn): `sessions.removed` is broadcast on C1 to all
   connected clients.
3. **Promptly** (asynchronously, but within ~ms): the session-proxy child process
   handles `SIGTERM` → calls `server.close()` → the OS closes all active C4
   connections → clients observe C4 close.

Both removal paths follow this ordering:
- `_refreshSessions()` (watcher-driven removal): lines `reapSessionProxy` then
  `_broadcastRemoved`.
- `_destroySession()` (explicit session.destroy command): lines `reapSessionProxy`
  then `killSession` then `_broadcastRemoved`.

**Key invariant:** `sessions.removed` is never emitted AFTER the C4 close. The
SIGTERM is sent before the broadcast, so the UDS close always follows the broadcast
— never precedes it.

### C3. Legal interleaving: C4 events in flight at removal time

There is one legal interleaving:

> **C4 events that were already in flight when `sessions.removed` was broadcast may
> still be delivered to the client after the client has received `sessions.removed`.**

This is a consequence of the async SIGTERM→close gap: between the moment the broker
broadcasts `sessions.removed` and the moment the OS closes the C4 socket, the
session-proxy may have already written additional events to the C4 socket buffer.
The kernel delivers these before the close.

A client that receives `sessions.removed` and then drains the C4 stream to EOF is
operating correctly.

### C4. Post-removal C4 traffic is a protocol violation (tripwire)

Any C4 traffic observed on a session-proxy connection **after** the client has:
1. Received `sessions.removed` for the session on C1, AND
2. Observed the C4 connection close (EOF / socket error)

…is a protocol violation. Specifically, any *new* C4 connection attempt to the
session-proxy socket after `sessions.removed` has been received is a tripwire error.
The client MAY treat this as an unrecoverable condition and log/surface it as a bug.

Rationale: the session-proxy UDS socket path is removed after the session-proxy child
exits. A successful reconnect to that path after removal indicates either:

- A stale socket file was not cleaned up (session-proxy crash before `removeSocket`).
- A race condition in the client's reconnect logic that should not exist.

---

## Timing Diagram

```
Broker (C1 stream)          Session-proxy child         Client
        |                           |                      |
        |  tmux session disappears  |                      |
        |  ──────────────────────>  |                      |
        |  reapSessionProxy()       |                      |
        |  ──SIGTERM──────────────> |                      |
        |  broadcastRemoved()       |                      |
        |  ──sessions.removed──────────────────────────>  |
        |                           | (processes SIGTERM)  |
        |                           | server.close() ──>  |  [C4 close / EOF]
        |                           | removeSocket()       |
        |                           | process.exit(0)      |
        |                           |                      |
                                                           ^ Client may see C4
                                                             events in flight here
                                                             (legal interleaving C3)
```

---

## Client-Side Obligations

On receiving `sessions.removed` for session `S`, a client MUST:

1. Stop issuing new C4 commands to the session-proxy for `S`.
2. Drain and process C4 events until the C4 connection closes (handle the legal
   interleaving — these are real events).
3. After C4 close, treat the session as fully gone. Any state associated with `S`
   may be torn down.

A client that re-opens a C4 connection to the session-proxy socket after step 3
is committing a protocol violation. The broker makes no guarantee the socket path
still exists, and reconnecting to a stale socket (if it exists at all) returns
a dead channel.

---

## Test Coverage

The contract is exercised by:

- **`L1` (broker-unit)**: removal via `_refreshSessions` calls `reapSessionProxy`
  before `_broadcastRemoved`.
- **`L2` (integration)**: `session.destroy` closes the session-proxy UDS; a client
  that connects to the UDS after destroy gets ENOENT/ECONNREFUSED.
- **`L3` (kill-under-load)**: a session being actively written to is externally
  killed; the test asserts `sessions.removed` arrives and the C4 UDS closes in
  the correct order, with C4 events-in-flight handled gracefully.

All tests in: `packages/server-proxy/src/session-removal-ordering.test.ts`

---

## Risk: R4 — E-wave consumers MUST read this first

The client-side tripwire behaviour described in C4 is intentional and MUST be
implemented in E-wave work (extension consumer). Without it, a client that receives
`sessions.removed` and then successfully reconnects to a stale C4 socket will
silently enter a zombie state — receiving no further events while appearing to be
connected.

This contract must be read before any E-wave bead that implements session-proxy
connection management.

---

## Implementation Notes

### Raw unhandshaked connections crash the session-proxy (tc-295a.6 finding)

A raw TCP connection to the session-proxy UDS that does not complete the
`client.capabilities` / `session-proxy.capabilities` handshake and is then closed
causes the session-proxy process to exit with code 1 in Node 22+. The cause is
`void sessionProxy.addClient(transport)` in `session-proxy-entry.ts` — the `void`
discards the rejected promise from a failed handshake, which Node 22 treats as an
unhandled rejection and converts to process exit.

**Consequence for tests:** tests that want to probe whether the C4 UDS is alive
must NOT use a raw `net.connect` + immediate `socket.destroy()`. Use
`fs.existsSync(socketPath)` to check for socket file presence, or complete a
proper session-proxy handshake before probing the connection state.

**Consequence for the contract:** this is an existing bug in the broker's
session-proxy-entry.ts, not a new contract. It is noted here because it
affects how clients should handle connection failures: a connection that fails
mid-handshake will cause the session-proxy to exit, triggering the same
`sessions.removed` + UDS-close chain as a normal session removal.
