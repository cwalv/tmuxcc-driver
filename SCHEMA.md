# tmuxcc Wire Protocols — Schema Reference

**Status:** Implemented (wire v3).
Single-session session-proxy protocol + per-socket server-proxy protocol.
See `src/wire/` for canonical types; this document is the human-readable reference.

---

## THE WIRE CONTRACT INVARIANT

The north-facing wire protocols speak in terms of **sessions (metadata),
panes, bytes, deltas, input, resize, layout**.
They MUST NEVER leak:

- **South-facing tmux vocabulary**: no `%output`, no `%begin`/`%end`, no
  tmux command numbers, no octal escapes, no layout-string syntax.
- **Renderer/host vocabulary**: no `Pseudoterminal`, no VS Code types,
  no DOM.

Each wire is the session-proxy-side process's *projection of its model*, not a
passthrough of tmux's control-mode syntax and not a renderer API. This is
what allows either side to be reimplemented in another language.

---

## Architecture overview

```
  [ tmux server (one socket) ]
       │   ── -CC attach -t <session> ─→     session-proxy south side (per-session)
       │   ── list-sessions, new-session ─→  server-proxy south side (server-wide)
       ▼
  [ session serverProxy ]               ← long-lived, one per tmux socket
       │
       ├─ spawns ─→ [ session-proxy S1 ]
       │              │   wire (per-session)
       │              ▼
       │           [ clients of S1 ]
       │
       └─ spawns ─→ [ session-proxy S2 ]
                      │   wire (per-session)
                      ▼
                   [ clients of S2 ]
```

The system has **two distinct wires** plus a **shared data plane**:

| Wire            | Scope            | Transport         | Carries                                              |
|-----------------|------------------|-------------------|------------------------------------------------------|
| **ServerProxy wire** | One tmux socket  | server-proxy socket     | session discovery + lifecycle + endpoint claim       |
| **SessionProxy wire** | One tmux session | per-session-proxy socket | pane/window/layout/focus model + commands            |
| **Data plane**  | One pane         | session-proxy socket     | raw pane output bytes (binary framing)               |

A client always talks to the server-proxy first ("give me session X" → endpoint),
then opens a session-proxy-wire connection on that endpoint.

The server-proxy is **stateless about pane content** — it shells out to
`tmux list-sessions` / `tmux new-session` / `tmux kill-session` for state,
and holds a single thin `tmux -CC` connection to receive
`%sessions-changed` push notifications. Per-session session-proxies are children
of the serverProxy; they hold the fat `tmux -CC attach -t <session>`
connections that carry pane events.

### Why split server-proxy and sessionProxy?

- **South-side reality.** `tmux -CC attach -t <name>` streams pane events
  only for the attached session. One control connection = one session of
  live data. Modeling the session-proxy as one-session-per-process matches that
  constraint exactly.
- **Discovery and lifecycle live above sessions**, not inside them. The
  set of sessions on a tmux socket, "create new session", and "is there
  already a session-proxy for session X?" don't belong in the per-session wire.
- **Test/production parity.** A server-proxy owns one socket. Production server-proxies
  use socket name `tmuxcc`; test server-proxies use `tmuxcc-test-<id>`. Socket
  naming becomes a single server-proxy constructor argument — no env-var
  threading, no defense-in-depth assertions, no hardcoded names in
  specs.

---

## Trust and security model (v3)

v3 assumes a **single-user, filesystem-permission trust model**:

- ServerProxy and session-proxy sockets live in `$XDG_RUNTIME_DIR/tmuxcc/` (or
  `/tmp/tmuxcc-<uid>/` as fallback) with the containing directory at
  mode 0700 and the sockets at mode 0600.
- There is no cryptographic authentication on either wire. Any local
  process the kernel grants socket access is trusted.
- Endpoint strings handed out by the serverProxy (`session.claim` response)
  are unix socket paths. They are documented as opaque to encourage
  clients not to depend on filesystem-level details, but a determined
  same-user process can bypass the serverProxy; that is intentional given
  the trust model.
- Cross-user or shared-machine deployments are out of scope for v3.

---

## Versioning

**`WIRE_PROTOCOL_VERSION = 3`** (monotonically-increasing integer)

- One version covers both server-proxy and session-proxy wires; they ship in lockstep.
- The version is exchanged once per connection via capabilities handshake
  on each wire.
- **Increment rule**: bump only for breaking schema changes (field removal,
  type change, discriminant rename). Additive changes (new optional fields,
  new message `type` values) are non-breaking.
- **Negotiation**: exact-match required. There is no downgrade or fallback
  in alpha. If sides disagree, the handshake fails.

### Version history

| Version | Change |
|---------|--------|
| `1`     | Initial wire schema: multi-session control plane (snapshot, deltas, commands, errors, input, resize.request). |
| `2`     | Added `resync.request` (client→sessionProxy). |
| `3`     | **ServerProxy wire introduced** + session-proxy wire becomes single-session. No in-place v2→v3 migration; pre-alpha rebuild on both sides. Multi-session machinery (plural `sessions[]` snapshot, `session.added` / `session.changed` deltas, `sessionId` fields on pane/window/layout/focus deltas, `sessionId` in `WireCommand`) moves to the server-proxy wire or is dropped entirely. |

---

## Shared primitives

Both wires use the same id types and envelope. Layout primitives are used
only by the session-proxy wire.

### Ids (`src/wire/ids.ts`)

```typescript
type SessionId = Brand<string, "SessionId">
type WindowId  = Brand<string, "WindowId">
type PaneId    = Brand<string, "PaneId">
```

All ids are opaque branded strings. The server-proxy / session-proxy mint them;
clients treat them as tokens. South-side `%N`/`@N`/`$N` tmux identifiers
are mapped to these and never appear on either wire.

- **`SessionId`** is used at the server-proxy layer to identify sessions and to
  request a session-proxy endpoint. It is **not** carried in session-proxy-wire delta
  payloads — every delta on the session-proxy wire is implicitly scoped to the
  session-proxy's bound session.
- **`WindowId`** and **`PaneId`** flow through the session-proxy wire as normal.
- A server-proxy mints a stable `SessionId` for each session it observes. The
  id is stable across the lifetime of the serverProxy, and is reused by all
  session-proxies spawned for that session.

### Envelope

All control-plane messages on both wires share:

```typescript
interface MessageBase {
  type: string;   // discriminant — used for TypeScript narrowing
  seq:  number;   // per-sender per-connection, monotonically increasing, starts at 1
}
```

#### Sequence-number semantics

- **Per-connection, per-sender.** Each control-plane connection has two
  independent counters: one for messages the local side sends, one for
  messages the local side receives. Counters start at 1 on connect.
- **ServerProxy and session-proxy connections are independent** even when both
  originate from the same client process. A client maintaining a server-proxy
  connection and one or more session-proxy connections owns one outgoing
  counter per connection.
- **Counters reset on reconnect.** A new transport connection (after a
  drop, or after a fresh server-proxy-mediated `session.claim`) starts a fresh
  counter at 1. There is no continuity across reconnects.
- Receivers MAY use gaps in the incoming counter to detect dropped
  messages. The session-proxy wire defines a `resync.request` recovery path
  (see "SessionProxy wire → resync"); the server-proxy wire has no equivalent —
  reconnect is the recovery path.

### Layout (`src/wire/layout.ts`) — session-proxy wire only

`Rect`, `LayoutNode` (`"pane" | "hsplit" | "vsplit"` discriminated union),
`WindowLayout`. tmux layout strings never appear on the wire; the session-proxy
parses them and emits a structured tree. See `src/wire/layout.ts` for
the full `LayoutNode` definition.

```typescript
interface Rect {
  x: number; y: number; cols: number; rows: number;
}

interface WindowLayout {
  cols: number;
  rows: number;
  root: LayoutNode;
}
```

### Capabilities

```typescript
interface Capabilities {
  protocolVersion: 3;
  features: readonly WireFeature[];
}
```

Each wire has its own feature set. See per-wire sections for valid
`WireFeature` values.

---

## ServerProxy wire

The server-proxy is a per-socket discovery and lifecycle service. Clients talk
to it first to learn what sessions exist and to obtain a session-proxy endpoint
for a specific session.

The server-proxy never carries pane data.

### Handshake

```
Client                                ServerProxy
  |---- transport.connect ----------->|
  |<--- server-proxy.capabilities (seq=1) --|   (1) server-proxy advertises
  |---- client.capabilities (seq=1) ->|   (2) client responds
  |                                   |
  |  both compute: version match +    |
  |  feature intersection             |
  |                                   |
  |<--- sessions.snapshot (seq=2) ----|   (3) initial session list
```

Feature set v3 for the server-proxy wire:

| Feature                  | Description                                       |
|--------------------------|---------------------------------------------------|
| `"sessions-watch"`       | Push notifications when the session set changes.  |
| `"session-create"`       | Client may request a new session.                 |
| `"session-destroy"`      | Client may request a session be killed.           |
| `"session-claim"`        | Client may obtain a session-proxy endpoint by session.   |

### `server-proxy.capabilities` — `ServerProxyCapabilitiesMessage`

direction: server-proxy→client. Sent once at handshake.

| Field          | Type           | Description                                |
|----------------|----------------|--------------------------------------------|
| `capabilities` | `Capabilities` | ServerProxy's protocol version + features.      |

### `client.capabilities` — `ClientCapabilitiesMessage`

direction: client→server-proxy. Sent once at handshake. Same shape as above.
Also used on the session-proxy wire — the same message type is sent on each
control-plane connection a client opens.

### `sessions.snapshot` — `ServerProxySnapshotMessage`

direction: server-proxy→client. Sent once after the server-proxy handshake.

The full current set of sessions known to this server-proxy. Clients use this
to populate their session picker without polling.

```typescript
interface ServerProxySnapshotMessage extends MessageBase {
  type: "sessions.snapshot";
  sessions: readonly ServerProxySessionInfo[];
}
```

#### `ServerProxySessionInfo`

| Field                | Type        | Description                                    |
|----------------------|-------------|------------------------------------------------|
| `sessionId`          | `SessionId` | ServerProxy-assigned id (stable across reconnect).  |
| `name`               | `string`    | tmux session name.                             |
| `windowCount`        | `number`    | Number of windows currently in this session.   |
| `attachedClientCount`| `number`    | Number of **external** (non-tmuxcc) clients attached. |

**`attachedClientCount` semantics (tc-3y8.7):** this is an *external-only*
count — it reports real human clients, not tmuxcc's own infrastructure.

tmux's raw `session_attached` includes tmuxcc's own `-CC` control-mode
clients: every claimed session has +1 (its session-proxy's `-CC attach`) and one
session has +2 (session-proxy + watcher, which attaches with
`-f no-output,ignore-size`).  The server-proxy subtracts these at the snapshot
layer so that `attachedClientCount` answers the question a UI cares about
("how many real users are in this session?").

Discrimination method: clients are identified as tmuxcc-owned when their
`client_flags` (from `tmux list-clients -F '#{client_flags}'`) contain
`control-mode` — a flag set exclusively on `-CC` (control-mode) attach
connections.  Regular terminal emulators never open a `-CC` connection.
Empirically verified on tmux 3.4:
  - session-proxy client:  `attached,focused,control-mode,UTF-8`
  - watcher client: `attached,focused,control-mode,ignore-size,no-output,UTF-8`

The value is never negative; `Math.max(0, raw − own)` is applied.

`windowCount` and `attachedClientCount` are static at snapshot time and
are not live-broadcast as they change. Clients that need live counts
should consult `sessions.snapshot` after `sessions.added` / `sessions.removed` deltas (they refresh the counts in the next snapshot transmitted, but counts aren't pushed independently).

### ServerProxy deltas (server-proxy→client, when `sessions-watch` is negotiated)

#### `sessions.added` — `ServerProxySessionAddedMessage`

| Field                | Type        | Description                                  |
|----------------------|-------------|----------------------------------------------|
| `sessionId`          | `SessionId` | Id of the newly observed session.            |
| `name`               | `string`    | Name of the session.                         |
| `windowCount`        | `number`    | Window count at add time (matches snapshot). |
| `attachedClientCount`| `number`    | Attached-client count at add time.           |

Shape mirrors `ServerProxySessionInfo` so clients applying the delta can
maintain their session model without polling.

#### `sessions.removed` — `ServerProxySessionRemovedMessage`

| Field       | Type        | Description                          |
|-------------|-------------|--------------------------------------|
| `sessionId` | `SessionId` | Id of the session that disappeared.  |

The server-proxy reaps the sessionProxy (if any) bound to this session before
emitting `sessions.removed`. Clients holding a stale session-proxy endpoint
will see their session-proxy connection close with `session.unavailable`
(see SessionProxy errors).

#### `sessions.renamed` — `ServerProxySessionRenamedMessage`

| Field       | Type        | Description                  |
|-------------|-------------|------------------------------|
| `sessionId` | `SessionId` | The renamed session.         |
| `newName`   | `string`    | The new display name.        |

### ServerProxy commands

ServerProxy commands use a parallel `command.request` / `command.response`
envelope, structurally separate from the session-proxy wire's commands. The
envelope shape is identical; only the command kinds differ.

#### `command.request` — `ServerProxyCommandRequestMessage`

direction: client→server-proxy

| Field           | Type            | Description                                                                 |
|-----------------|-----------------|-----------------------------------------------------------------------------|
| `correlationId` | `string`        | Client-generated opaque string, echoed in the matching response.            |
| `command`       | `ServerProxyCommand` | The server-proxy operation to perform (discriminated union).                      |

#### `ServerProxyCommand` — discriminated union on `kind`

| `kind`              | Extra fields              | Response payload                                          |
|---------------------|---------------------------|-----------------------------------------------------------|
| `"session.claim"`   | `name: string`            | `{ sessionId, endpoint, created }` — creates session + session-proxy if absent |
| `"session.create"`  | `name: string`            | `{ sessionId, endpoint, created }` — fails if name in use |
| `"session.destroy"` | `sessionId: SessionId`    | `{ ok: true }` — destroys session + reaps session-proxy          |
| `"server-proxy.info"`     | —                         | `{ info: ServerProxyInfoPayload }` — read-only diagnostics snapshot (tc-k6v) |

#### `command.response` — `ServerProxyCommandResponseMessage`

direction: server-proxy→client

| Field           | Type     | Description                                              |
|-----------------|----------|----------------------------------------------------------|
| `correlationId` | `string` | Echoed from the matching request.                        |
| `result`        | union    | `{ ok: true; payload: ServerProxyCommandOkPayload }` on success, or `{ ok: false; code: string; message: string }` on failure. |

**`ServerProxyCommandOkPayload`** (per-kind):

| Kind                | Payload                                                         |
|---------------------|-----------------------------------------------------------------|
| `"session.claim"`   | `{ sessionId: SessionId; endpoint: string; created: boolean }`  |
| `"session.create"`  | `{ sessionId: SessionId; endpoint: string; created: boolean }`  |
| `"session.destroy"` | `{ ok: true }`                                                  |
| `"server-proxy.info"`     | `{ info: ServerProxyInfoPayload }`                                   |

`endpoint` is an opaque connection string (unix socket path under the
v3 trust model). Clients pass it to `createSessionProxyTransport(endpoint)`.

`created` reports whether THIS command minted the tmux session (`true`)
or attached to a pre-existing one (`false`). The server-proxy is the system's
single create-or-attach point, so this flag is the authority for
create-time-only client behaviour — notably profile apply (tc-3y8.2):
profiles apply exactly once, at session creation, never on attach.
A successful `session.create` always reports `created: true` (it either
mints or fails `session.name-taken`; an in-flight claim for the same
name counts as taken). Only `session.claim` can resolve either way.

#### `session.claim` semantics

- If a session-proxy for `name` already exists, return its endpoint
  (`created: false`).
- If `name` does not exist as a tmux session, mint one (`tmux new-session
  -d -s <name>`), then spawn a session-proxy bound to it, then return
  (`created: true`).
- If `name` exists as a tmux session but no session-proxy is bound, spawn one
  and return (`created: false` — the session pre-existed; only the
  session-proxy is new).

**Per-name atomicity:** concurrent `session.claim` requests with the
same `name` receive identical `{ sessionId, endpoint }` responses. The
server-proxy serializes session creation and session-proxy spawn against the name so
that two clients racing each other do not produce two session-proxies. Requests
that join an in-flight claim receive `created: false` — exactly one
claimant observes `created: true` per session creation, so create-time
behaviour (profile apply) runs at most once even under racing claims.

#### `server-proxy.info` semantics (tc-k6v)

Read-only diagnostics snapshot for debug surfaces (the VS Code
`tmuxcc.showServerProxyInfo` command). The server-proxy answers from its in-memory
state plus cheap synchronous tmux queries (`list-sessions`,
`list-panes -a`); nothing is mutated. Additive and non-breaking: older
server-proxies respond `protocol.unknown-message`.

**`ServerProxyInfoPayload`:**

| Field                  | Type                          | Description                                                       |
|------------------------|-------------------------------|-------------------------------------------------------------------|
| `socketName`           | `string`                      | tmux socket name the server-proxy serves (= server-proxy runtime-dir name).   |
| `serverProxySocketPath`     | `string`                      | Absolute path of the server-proxy's unix socket.                        |
| `serverProxyPid`            | `number`                      | ServerProxy process PID.                                               |
| `uptimeMs`             | `number`                      | Milliseconds since the server-proxy's `start()` completed.              |
| `tmuxServerPid`        | `number \| null`              | tmux server PID, or `null` if no server is running.               |
| `adoptedExistingServer`| `boolean`                     | `true` iff sessions already existed at server-proxy start (ext-a §6.2 "adopted server"). |
| `connectedClientCount` | `number`                      | Raw IPC connection count (incl. the requesting connection).       |
| `logPath`              | `string \| null`              | ServerProxy log file path, or `null` when started without log redirection. |
| `sessions`             | `ServerProxyInfoSession[]`         | Per-session diagnostics rows.                                     |

**`ServerProxyInfoSession`:** `{ sessionId, name, sessionProxyPid, windowCount,
paneCount, attachedClientCount }`. `sessionProxyPid` is `null` when no session-proxy
is currently running for the session (unclaimed, or crashed pending lazy
respawn). `attachedClientCount` is the **external-only** count: tmuxcc's
own `-CC` control-mode clients (session-proxy + watcher) are subtracted from
tmux's raw `session_attached` value at the server-proxy snapshot layer (tc-3y8.7).
See `ServerProxySessionInfo.attachedClientCount` above for full semantics.

**ServerProxy log file:** the server-proxy entry point (`server-proxy-entry.ts`) mirrors
the process's stderr into an append-only log file at
`<runtime>/<socketName>/server-proxy.log` (mode 0600, no rotation — tc-k6v).
`server-proxy.info` reports the path as `logPath`; in-process/programmatic
server-proxies that skip the entry point have no log file (`logPath: null`).

### ServerProxy errors

#### `error` — `ErrorMessage` (server-proxy wire)

Same envelope as the session-proxy wire's `ErrorMessage` (see "SessionProxy errors"
below). ServerProxy-wire error codes:

| Code                          | Cause                                                                |
|-------------------------------|----------------------------------------------------------------------|
| `"protocol.unknown-message"`  | Unknown message type received. Message dropped.                      |
| `"protocol.malformed"`        | Parse failure.                                                       |
| `"protocol.version-mismatch"` | Handshake version mismatch.                                          |
| `"session.not-found"`         | `session.claim` or `session.destroy` named an unknown session.       |
| `"session.name-taken"`        | `session.create` requested a name already in use.                    |
| `"tmux.unavailable"`          | Underlying tmux server is gone or refusing commands.                 |
| `"internal"`                  | Unexpected server-proxy-side error.                                        |

Future codes may be added; clients MUST treat unknown codes as opaque
strings.

### ServerProxy lifecycle

ServerProxy lifecycle is specified by the component-lifetime model
(`projects/tmuxcc/docs/ext-a-design-context.md` Part 6) and the server-proxy
README ("Lifecycle" section):

- A server-proxy is spawned lazily (detached) by the first client launcher
  that finds no server-proxy socket; thereafter it manages its own exit —
  immediate on tmux-server death, 5-minute hysteresis on zero
  IPC-connected clients.
- SessionProxys are non-detached server-proxy children and MUST die with the serverProxy
  (PDEATHSIG on Linux, getppid-poll on macOS — enforcement: tc-2c5). A
  dead server-proxy never leaves serving orphans; recovery is a fresh server-proxy +
  fresh session-proxies against the surviving tmux state. There is no
  orphan-and-reclaim path.
- The server-proxy is responsible for its own socket file's lifecycle; on
  exit it removes the socket.

---

## SessionProxy wire

The session-proxy wire is per-session. A connection is bound to exactly one tmux
session for its lifetime. There is no concept of "the active session"
because there is only ever one.

### Lifecycle and switch-client handling

A session-proxy's tmux south-side connection is `-CC attach -t <bound-session>`.
tmux may emit `%session-changed` notifications when something elsewhere
on the server changes the attached session for this `-CC` control
client (a user running `:switch-client` from another window, for
instance).

The session-proxy's response is narrow and recoverable when possible:

1. **Filter to this `-CC` client's own session changes.** `%session-changed`
   notifications for *other* control clients are ignored.
2. **If the new attached session equals `<bound>`:** no-op. The session-proxy
   is still correctly bound; the wire emits nothing.
3. **If the new attached session differs from `<bound>`:** query
   `tmux list-sessions`.
   - If `<bound>` is still present: silently issue `attach-session -t
     <bound>` on the `-CC` connection to restore the binding. Nothing
     surfaces on the wire.
   - If `<bound>` is gone from the session list: emit `ErrorMessage`
     with code `"session.unavailable"` and close all client connections
     on this session-proxy. The server-proxy observes the session-proxy process exit and
     emits `sessions.removed` to remaining server-proxy-wire subscribers.

This means the only *fatal* session-proxy-wire event for a tmuxcc client is
genuine session disappearance. Routine `switch-client` from elsewhere
is invisible.

### Multiple clients on one session-proxy

A single session-proxy can serve multiple concurrent client connections (e.g.,
two VS Code windows opening the same workspace simultaneously). Each
connection is independent:

- Each gets its own server-proxy → session-proxy claim and its own session-proxy-wire
  transport. The server-proxy hands out the same `endpoint` for the same
  session name; the session-proxy accepts multiple inbound connections on its
  socket.
- Each connection runs its own handshake, receives its own
  `SnapshotMessage` at its own seq=2, and maintains its own outgoing
  seq counter on the session-proxy side.
- Deltas are fan-out: a single tmux event becomes N session-proxy-wire deltas,
  one per connected client, each stamped with that client's per-connection
  seq.
- `attachedClientCount` in the snapshot is the count at the moment of
  snapshot construction. It is not live-broadcast on changes. Clients
  needing live counts MAY issue a fresh `resync.request` to refresh.

The session-proxy owns one upstream `-CC attach` connection regardless of
client count — the multi-client model is north-side only.

### Handshake

```
Client                                SessionProxy
  |---- transport.connect ----------->|
  |<--- session-proxy.capabilities (seq=1) --|   (1) session-proxy advertises
  |---- client.capabilities (seq=1) ->|   (2) client responds
  |                                   |
  |<--- snapshot (seq=2) -------------|   (3) initial model
  |<--- delta…   (seq=3..) -----------|   (4) live updates
```

Feature set v3 for the session-proxy wire:

| Feature              | Description                                         |
|----------------------|-----------------------------------------------------|
| `"pane-lifecycle"`   | Pane open/close/resize events.                      |
| `"layout-updates"`   | Structured window layout pushes.                    |
| `"focus-events"`     | Active-pane focus notifications.                    |
| `"input-forwarding"` | Client→session-proxy key/text input.                       |

### `session-proxy.capabilities` — `SessionProxyCapabilitiesMessage`

direction: session-proxy→client. Sent once at handshake. Carries `Capabilities`.

### `snapshot` — `SnapshotMessage`

direction: session-proxy→client. Sent once after handshake.

Carries the complete state of **this connection's bound session**. There
is no plural sessions array; the session is implicit on every subsequent
delta.

```typescript
interface SnapshotMessage extends MessageBase {
  type: "snapshot";
  session: SnapshotSession;
  windows: readonly SnapshotWindow[];
  panes:   readonly SnapshotPane[];
  focus: {
    paneId:   PaneId   | null;
    windowId: WindowId | null;
  };
  attachedClientCount?: number;  // static at snapshot time; not live-updated
}
```

#### `SnapshotSession`

| Field       | Type        | Description                  |
|-------------|-------------|------------------------------|
| `sessionId` | `SessionId` | Bound session's id.          |
| `name`      | `string`    | Bound session's display name.|

#### `SnapshotWindow`

| Field      | Type           | Description                                      |
|------------|----------------|--------------------------------------------------|
| `windowId` | `WindowId`     | Window identifier.                               |
| `name`     | `string`       | Window display name.                             |
| `active`   | `boolean`      | True if this is the active window in the session.|
| `layout`   | `WindowLayout` | Structured pane layout tree.                     |

#### `SnapshotPane`

| Field      | Type       | Description           |
|------------|------------|-----------------------|
| `paneId`   | `PaneId`   | Pane identifier.      |
| `windowId` | `WindowId` | Parent window.        |
| `cols`     | `number`   | Width in columns.     |
| `rows`     | `number`   | Height in rows.       |

#### `focus`

The currently focused pane/window pair, or null/null when no pane is
focused. The session is always the bound session; no `sessionId` field.

### Pane deltas (session-proxy→client)

#### `pane.opened` — `PaneOpenedMessage`

| Field      | Type       | Description                                          |
|------------|------------|------------------------------------------------------|
| `paneId`   | `PaneId`   | SessionProxy-assigned wire id for the new pane.            |
| `windowId` | `WindowId` | Window containing the pane.                          |
| `cols`     | `number`   | Initial width in columns.                            |
| `rows`     | `number`   | Initial height in rows.                              |
| `active`   | `boolean`  | True if this pane is active at open time.            |

#### `pane.closed` — `PaneClosedMessage`

| Field       | Type       | Description                                                                             |
|-------------|------------|-----------------------------------------------------------------------------------------|
| `paneId`    | `PaneId`   | The closed pane.                                                                        |
| `windowId`  | `WindowId` | Former parent window.                                                                   |
| `exitCode?` | `number`   | Exit code of the pane's process, if known. Absent when tmux did not report a per-pane exit status (the common case with `%window-close`). |

#### `pane.resized` — `PaneResizedMessage`

| Field    | Type     | Description                |
|----------|----------|----------------------------|
| `paneId` | `PaneId` | The resized pane.          |
| `cols`   | `number` | New width in columns.      |
| `rows`   | `number` | New height in rows.        |

#### `pane.mode-changed` — `PaneModeChangedMessage`

| Field    | Type       | Description                                                                              |
|----------|------------|------------------------------------------------------------------------------------------|
| `paneId` | `PaneId`   | The pane whose mode changed.                                                             |
| `mode`   | `PaneMode` | New mode: `"normal"`, `"copy"`, `"view"`, or future opaque string.                       |

### Window deltas (session-proxy→client)

#### `window.added` — `WindowAddedMessage`

| Field      | Type       | Description                                                     |
|------------|------------|-----------------------------------------------------------------|
| `windowId` | `WindowId` | SessionProxy-assigned id for the new window.                          |
| `name`     | `string`   | Initial window name.                                            |
| `active`   | `boolean`  | True if the new window immediately became the active window.    |

#### `window.closed` — `WindowClosedMessage`

| Field      | Type       | Description        |
|------------|------------|--------------------|
| `windowId` | `WindowId` | The closed window. |

#### `window.renamed` — `WindowRenamedMessage`

| Field      | Type       | Description           |
|------------|------------|-----------------------|
| `windowId` | `WindowId` | The renamed window.   |
| `newName`  | `string`   | The new display name. |

### Layout deltas (session-proxy→client)

#### `layout.updated` — `LayoutUpdatedMessage`

| Field      | Type           | Description                      |
|------------|----------------|----------------------------------|
| `windowId` | `WindowId`     | The window whose layout changed. |
| `layout`   | `WindowLayout` | Full current layout tree.        |

### Focus deltas (session-proxy→client)

#### `focus.changed` — `FocusChangedMessage`

| Field      | Type               | Description                                        |
|------------|--------------------|----------------------------------------------------|
| `paneId`   | `PaneId   \| null` | Newly focused pane, or `null` if no pane is active.|
| `windowId` | `WindowId \| null` | Window of the focused pane, or `null`.             |

### Session delta (session-proxy→client) — only one

#### `session.renamed` — `SessionProxySessionRenamedMessage`

| Field     | Type     | Description                                |
|-----------|----------|--------------------------------------------|
| `newName` | `string` | The new display name of the bound session. |

No `sessionId` field — there's only one session. The server-proxy emits its
own `ServerProxySessionRenamedMessage` to other server-proxy-wire subscribers.
Ordering between the server-proxy-wire and session-proxy-wire rename events on a
single client is not guaranteed; clients should treat the later arrival
as canonical.

Session creation and destruction are not session-proxy-wire concerns. Creation
happens at the server-proxy. Destruction surfaces as an `ErrorMessage` with
code `"session.unavailable"` and a connection close.

### Commands (session-proxy wire)

Commands are client-initiated model operations. The client sends a
`command.request`; the session-proxy sends exactly one `command.response`
correlated by `correlationId`. Side-effects arrive as normal deltas.

#### `command.request` — `SessionProxyCommandRequestMessage`

direction: client→session-proxy

| Field           | Type          | Description                                                                 |
|-----------------|---------------|-----------------------------------------------------------------------------|
| `correlationId` | `string`      | Client-generated opaque string, echoed in the matching `command.response`.  |
| `command`       | `WireCommand` | The model operation to perform.                                             |

#### `WireCommand` — discriminated union on `kind`

All commands operate within the bound session. None carry `sessionId`.

| `kind`             | Extra fields                                           | Description                                                   |
|--------------------|--------------------------------------------------------|---------------------------------------------------------------|
| `"open-window"`    | `name?`, `cwd?`, `shellCommand?`                       | Open a new window in the bound session.                       |
| `"split-pane"`     | `paneId?`, `direction: "horizontal" \| "vertical"`, `cwd?`, `shellCommand?` | Split a pane. `paneId` optional — when absent the session-proxy splits the current pane. |
| `"close-pane"`     | `paneId`                                               | Kill a pane.                                                  |
| `"rename-window"`  | `windowId`, `name`                                     | Rename a window.                                              |
| `"select-pane"`    | `paneId`                                               | Focus a pane.                                                 |
| `"resize-pane"`    | `paneId`, `cols`, `rows`                               | Resize a pane to explicit dimensions.                         |
| `"kill-session"`   | `sessionName: string`                                  | Kill the tmux session entirely. SessionProxy emits `ErrorMessage{code:"session.unavailable"}` and closes all client connections. Uses session name (not id) to avoid fragile numeric-id mapping. |

#### `command.response` — `SessionProxyCommandResponseMessage`

direction: session-proxy→client

| Field           | Type     | Description                                              |
|-----------------|----------|----------------------------------------------------------|
| `correlationId` | `string` | Echoed from the matching `command.request`.              |
| `result`        | union    | `{ ok: true; payload?: SessionProxyCommandOkPayload }` on success, or `{ ok: false; code: string; message: string }` on failure. |

**`SessionProxyCommandOkPayload`**:

| Field      | Type        | Description                                      |
|------------|-------------|--------------------------------------------------|
| `windowId` | `WindowId?` | Set by `open-window` for the newly created window.|
| `paneId`   | `PaneId?`   | Set by `open-window` and `split-pane`.            |

### SessionProxy errors

#### `error` — `ErrorMessage`

direction: session-proxy→client. Used only for errors NOT attributable to a
specific outstanding `command.request`. Command failures arrive in
`command.response` with `result.ok = false`.

| Field           | Type            | Description                                                                         |
|-----------------|-----------------|-------------------------------------------------------------------------------------|
| `code`          | `WireErrorCode` | Machine-readable error code.                                                        |
| `message`       | `string`        | Human-readable description.                                                         |
| `correlationId` | `string?`       | Optional. Ties this error to a prior request that will NOT receive a response.      |

**SessionProxy-wire `WireErrorCode`** values:

| Code                          | Description                                                                        |
|-------------------------------|------------------------------------------------------------------------------------|
| `"protocol.unknown-message"`  | Unknown message type received.                                                     |
| `"protocol.malformed"`        | Parse failure.                                                                     |
| `"protocol.version-mismatch"` | Version negotiation failed.                                                        |
| `"session.unavailable"`       | The bound session is no longer reachable. Connection is being closed; reconnect via server-proxy. |
| `"internal"`                  | Unexpected session-proxy-side error.                                                      |

Future codes may be added; clients MUST treat unknown codes as opaque
strings.

After `"session.unavailable"` or `"protocol.version-mismatch"`, the
client must consider the connection dead. If the client wants to keep
working, it reconnects through the server-proxy.

### Client → SessionProxy messages (input and viewport)

#### `input` — `InputMessage`

| Field    | Type     | Description                                                                 |
|----------|----------|-----------------------------------------------------------------------------|
| `paneId` | `PaneId` | Target pane.                                                                |
| `data`   | `string` | UTF-8 text. Special keys pre-encoded as escape sequences by the client.     |

Known limitation: `data` is `string`, which means only valid UTF-8 can
be expressed. This is asymmetric with the output plane (byte-clean). A
binary input path would need a sibling `InputBytesMessage`
(`Uint8Array`) and a protocol-version bump. Left as a future extension.

#### `resize.request` — `ResizeRequestMessage`

| Field    | Type     | Description       |
|----------|----------|-------------------|
| `paneId` | `PaneId` | Target pane.      |
| `cols`   | `number` | Requested width.  |
| `rows`   | `number` | Requested height. |

SessionProxy applies and responds with `pane.resized` delta.

#### `resync.request` — `ResyncRequestMessage`

Client requests the session-proxy re-send a full snapshot for this connection.
No payload beyond `type` and `seq`.

**When sent:** the client mirror detects a seq gap. **SessionProxy response:**
re-sends `SnapshotMessage` at the next per-connection seq (no seq reset).

Send-once-and-dedup policy:
1. On gap detect: set `resyncRequested` flag; send `resync.request` once.
2. On snapshot arrival: clear the flag.
3. While the flag is set: ignore further gap signals.
4. If a gap is detected after the snapshot delivers: escalate to
   `transport.close()`. Reconnect path goes through server-proxy.

After a server-proxy-mediated reconnect: the client opens a fresh session-proxy-wire
connection. The new connection's seq counter starts at 1, and the
`resyncRequested` flag MUST be cleared. There is no state continuity
across reconnects.

---

## Union types

```typescript
// server-proxy-control.ts
type ServerProxyMessage =
  | ServerProxyCapabilitiesMessage
  | ServerProxySnapshotMessage
  | ServerProxySessionAddedMessage
  | ServerProxySessionRemovedMessage
  | ServerProxySessionRenamedMessage
  | ServerProxyCommandResponseMessage;
// ErrorMessage (type: "error") is shared between server-proxy and session-proxy wires.
// It is defined in session-proxy-control.ts and re-used on the server-proxy wire with
// server-proxy-wire error codes. It is not included in the ServerProxyMessage union
// because the TypeScript type for ErrorMessage is identical on both wires.

type SessionProxyMessage =
  | SessionProxyCapabilitiesMessage
  | SnapshotMessage
  | PaneOpenedMessage
  | PaneClosedMessage
  | PaneResizedMessage
  | PaneModeChangedMessage
  | WindowAddedMessage
  | WindowClosedMessage
  | WindowRenamedMessage
  | LayoutUpdatedMessage
  | FocusChangedMessage
  | SessionProxySessionRenamedMessage
  | SessionProxyCommandResponseMessage
  | ErrorMessage;                   // session-proxy-wire codes

type ClientMessage =
  | ClientCapabilitiesMessage       // both wires
  | ServerProxyCommandRequestMessage     // server-proxy wire
  | SessionProxyCommandRequestMessage     // session-proxy wire
  | InputMessage                    // session-proxy wire
  | ResizeRequestMessage            // session-proxy wire
  | ResyncRequestMessage;           // session-proxy wire

type ControlMessage = ServerProxyMessage | SessionProxyMessage | ClientMessage;
```

ServerProxy-wire and session-proxy-wire `command.request` / `command.response`
share the envelope shape but carry distinct command unions. The
`type: "command.request"` discriminant alone is ambiguous; in practice
clients and servers know which wire they're on from the transport, and
the `command.kind` discriminates further.

### Type guards

| Guard              | Narrows to       |
|--------------------|------------------|
| `isControlMessage` | `ControlMessage` |
| `isServerProxyMessage`  | `ServerProxyMessage`  |
| `isSessionProxyMessage`  | `SessionProxyMessage`  |
| `isClientMessage`  | `ClientMessage`  |

`isControlMessage` is a shallow structural check (`type: string`,
`seq: number`). Use a runtime schema validator for full validation.

---

## Data plane (`src/wire/framing.ts`) — bead tc-2mq

Unchanged from v2. The data plane carries raw terminal output bytes per
pane. Binary framing — not JSON or base64 — because hot-path volumes make
escaping or inflation material.

The data-plane transport is the same per-session-proxy socket as the session-proxy
control wire. Control-plane and data-plane traffic are multiplexed on
the same connection via a leading magic byte (data plane: `0xCC`;
control plane: JSON, never starts with `0xCC`).

### Frame byte layout

```
Offset  Size   Type           Field     Description
------  -----  -------------  --------  ------------------------------------------
     0      1  u8             MAGIC     0xCC — magic byte for framing verification
     1      4  u32 big-endian SEQ       Per-pane monotonic sequence number
     5      4  u32 big-endian PAYLEN    Payload byte length
     9      2  u16 big-endian IDLEN     paneId UTF-8 byte length
    11  IDLEN  UTF-8 bytes    PANEID    paneId string encoded as UTF-8
11+IDLEN PAYLEN raw bytes     PAYLOAD   Raw terminal output bytes (any byte value)
```

Total frame size: `11 + IDLEN + PAYLEN` bytes. `MAX_FRAME` is 8 MiB; the
decoder rejects oversized frames with a `RangeError`. See v2 SCHEMA for
detailed rationale on field sizes, base64-vs-binary choice, and the
streaming decoder design — none of which changed in v3.

### API

```typescript
export const FRAME_MAGIC = 0xCC;

export interface DataFrame {
  paneId:  PaneId;
  seq:     number;
  payload: Uint8Array;
}

export function encodeFrame(paneId: PaneId, seq: number, payload: Uint8Array): Uint8Array;
export function decodeFrame(buf: Uint8Array): DataFrame;

export class FrameDecoder {
  push(chunk: Uint8Array): DataFrame[];
}
```

Sequence numbers are per-pane, owned by the sessionProxy, starting at 0. Clients
use them to detect drops and (rarely) restore ordering.

---

## File layout

```
src/wire/
  ids.ts             — SessionId, WindowId, PaneId
  layout.ts          — WindowLayout, LayoutNode, Rect
  envelope.ts        — MessageBase, Capabilities, shared type guards
  server-proxy-control.ts  — ServerProxy wire control messages + ServerProxyCommand union
  session-proxy-control.ts  — SessionProxy wire control messages + WireCommand union
  transport.ts       — Transport seam (control + data plane multiplexed) + in-memory pair
  framing.ts         — Data-plane binary frame format (unchanged)
  handshake.ts       — Handshake helpers (shared between server-proxy and session-proxy wires)
  index.ts           — Public barrel
  *.test.ts          — Per-module tests
SCHEMA.md            — This document
```

---

## Implementation status (epic tc-j9c)

All five implementation stages have shipped:

| Stage | Work | Bead |
|-------|------|------|
| 0 | Wire schema split — `envelope.ts`, `session-proxy-control.ts`, `server-proxy-control.ts`, `handshake.ts` | tc-j9c.1 |
| 1 | SessionProxy wire → single-session; client mirror single-session migration | tc-j9c.2 |
| 2 | `tmuxcc-broker` package — server-proxy wire, supervisor, tmux south-side | tc-j9c.3 |
| 3 | VS Code extension — server-proxy-mediated activation flow | tc-j9c.4 |
| 4 | Test harness — per-test server-proxy isolation | tc-j9c.5 |
| 5 | Docs pass — this reconciliation | tc-j9c.6 |

The switch-client narrowing follow-up (runtime path narrowing for `%session-changed`)
was delivered in bead tc-j9c.7.
