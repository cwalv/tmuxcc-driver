# tmuxcc Wire Protocols — Schema Reference

**Status:** Implemented (wire v3).
Single-session daemon protocol + per-socket broker protocol.
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

Each wire is the daemon-side process's *projection of its model*, not a
passthrough of tmux's control-mode syntax and not a renderer API. This is
what allows either side to be reimplemented in another language.

---

## Architecture overview

```
  [ tmux server (one socket) ]
       │   ── -CC attach -t <session> ─→     daemon south side (per-session)
       │   ── list-sessions, new-session ─→  broker south side (server-wide)
       ▼
  [ session broker ]               ← long-lived, one per tmux socket
       │
       ├─ spawns ─→ [ daemon S1 ]
       │              │   wire (per-session)
       │              ▼
       │           [ clients of S1 ]
       │
       └─ spawns ─→ [ daemon S2 ]
                      │   wire (per-session)
                      ▼
                   [ clients of S2 ]
```

The system has **two distinct wires** plus a **shared data plane**:

| Wire            | Scope            | Transport         | Carries                                              |
|-----------------|------------------|-------------------|------------------------------------------------------|
| **Broker wire** | One tmux socket  | broker socket     | session discovery + lifecycle + endpoint claim       |
| **Daemon wire** | One tmux session | per-daemon socket | pane/window/layout/focus model + commands            |
| **Data plane**  | One pane         | daemon socket     | raw pane output bytes (binary framing)               |

A client always talks to the broker first ("give me session X" → endpoint),
then opens a daemon-wire connection on that endpoint.

The broker is **stateless about pane content** — it shells out to
`tmux list-sessions` / `tmux new-session` / `tmux kill-session` for state,
and holds a single thin `tmux -CC` connection to receive
`%sessions-changed` push notifications. Per-session daemons are children
of the broker; they hold the fat `tmux -CC attach -t <session>`
connections that carry pane events.

### Why split broker and daemon?

- **South-side reality.** `tmux -CC attach -t <name>` streams pane events
  only for the attached session. One control connection = one session of
  live data. Modeling the daemon as one-session-per-process matches that
  constraint exactly.
- **Discovery and lifecycle live above sessions**, not inside them. The
  set of sessions on a tmux socket, "create new session", and "is there
  already a daemon for session X?" don't belong in the per-session wire.
- **Test/production parity.** A broker owns one socket. Production brokers
  use socket name `tmuxcc`; test brokers use `tmuxcc-test-<id>`. Socket
  naming becomes a single broker constructor argument — no env-var
  threading, no defense-in-depth assertions, no hardcoded names in
  specs.

---

## Trust and security model (v3)

v3 assumes a **single-user, filesystem-permission trust model**:

- Broker and daemon sockets live in `$XDG_RUNTIME_DIR/tmuxcc/` (or
  `/tmp/tmuxcc-<uid>/` as fallback) with the containing directory at
  mode 0700 and the sockets at mode 0600.
- There is no cryptographic authentication on either wire. Any local
  process the kernel grants socket access is trusted.
- Endpoint strings handed out by the broker (`session.claim` response)
  are unix socket paths. They are documented as opaque to encourage
  clients not to depend on filesystem-level details, but a determined
  same-user process can bypass the broker; that is intentional given
  the trust model.
- Cross-user or shared-machine deployments are out of scope for v3.

---

## Versioning

**`WIRE_PROTOCOL_VERSION = 3`** (monotonically-increasing integer)

- One version covers both broker and daemon wires; they ship in lockstep.
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
| `2`     | Added `resync.request` (client→daemon). |
| `3`     | **Broker wire introduced** + daemon wire becomes single-session. No in-place v2→v3 migration; pre-alpha rebuild on both sides. Multi-session machinery (plural `sessions[]` snapshot, `session.added` / `session.changed` deltas, `sessionId` fields on pane/window/layout/focus deltas, `sessionId` in `WireCommand`) moves to the broker wire or is dropped entirely. |

---

## Shared primitives

Both wires use the same id types and envelope. Layout primitives are used
only by the daemon wire.

### Ids (`src/wire/ids.ts`)

```typescript
type SessionId = Brand<string, "SessionId">
type WindowId  = Brand<string, "WindowId">
type PaneId    = Brand<string, "PaneId">
```

All ids are opaque branded strings. The broker / daemon mint them;
clients treat them as tokens. South-side `%N`/`@N`/`$N` tmux identifiers
are mapped to these and never appear on either wire.

- **`SessionId`** is used at the broker layer to identify sessions and to
  request a daemon endpoint. It is **not** carried in daemon-wire delta
  payloads — every delta on the daemon wire is implicitly scoped to the
  daemon's bound session.
- **`WindowId`** and **`PaneId`** flow through the daemon wire as normal.
- A broker mints a stable `SessionId` for each session it observes. The
  id is stable across the lifetime of the broker, and is reused by all
  daemons spawned for that session.

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
- **Broker and daemon connections are independent** even when both
  originate from the same client process. A client maintaining a broker
  connection and one or more daemon connections owns one outgoing
  counter per connection.
- **Counters reset on reconnect.** A new transport connection (after a
  drop, or after a fresh broker-mediated `session.claim`) starts a fresh
  counter at 1. There is no continuity across reconnects.
- Receivers MAY use gaps in the incoming counter to detect dropped
  messages. The daemon wire defines a `resync.request` recovery path
  (see "Daemon wire → resync"); the broker wire has no equivalent —
  reconnect is the recovery path.

### Layout (`src/wire/layout.ts`) — daemon wire only

`Rect`, `LayoutNode` (`"pane" | "hsplit" | "vsplit"` discriminated union),
`WindowLayout`. tmux layout strings never appear on the wire; the daemon
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

## Broker wire

The broker is a per-socket discovery and lifecycle service. Clients talk
to it first to learn what sessions exist and to obtain a daemon endpoint
for a specific session.

The broker never carries pane data.

### Handshake

```
Client                                Broker
  |---- transport.connect ----------->|
  |<--- broker.capabilities (seq=1) --|   (1) broker advertises
  |---- client.capabilities (seq=1) ->|   (2) client responds
  |                                   |
  |  both compute: version match +    |
  |  feature intersection             |
  |                                   |
  |<--- sessions.snapshot (seq=2) ----|   (3) initial session list
```

Feature set v3 for the broker wire:

| Feature                  | Description                                       |
|--------------------------|---------------------------------------------------|
| `"sessions-watch"`       | Push notifications when the session set changes.  |
| `"session-create"`       | Client may request a new session.                 |
| `"session-destroy"`      | Client may request a session be killed.           |
| `"session-claim"`        | Client may obtain a daemon endpoint by session.   |

### `broker.capabilities` — `BrokerCapabilitiesMessage`

direction: broker→client. Sent once at handshake.

| Field          | Type           | Description                                |
|----------------|----------------|--------------------------------------------|
| `capabilities` | `Capabilities` | Broker's protocol version + features.      |

### `client.capabilities` — `ClientCapabilitiesMessage`

direction: client→broker. Sent once at handshake. Same shape as above.
Also used on the daemon wire — the same message type is sent on each
control-plane connection a client opens.

### `sessions.snapshot` — `BrokerSnapshotMessage`

direction: broker→client. Sent once after the broker handshake.

The full current set of sessions known to this broker. Clients use this
to populate their session picker without polling.

```typescript
interface BrokerSnapshotMessage extends MessageBase {
  type: "sessions.snapshot";
  sessions: readonly BrokerSessionInfo[];
}
```

#### `BrokerSessionInfo`

| Field                | Type        | Description                                    |
|----------------------|-------------|------------------------------------------------|
| `sessionId`          | `SessionId` | Broker-assigned id (stable across reconnect).  |
| `name`               | `string`    | tmux session name.                             |
| `windowCount`        | `number`    | Number of windows currently in this session.   |
| `attachedClientCount`| `number`    | Number of tmuxcc clients currently attached.   |

`windowCount` and `attachedClientCount` are static at snapshot time and
are not live-broadcast as they change. Clients that need live counts
should consult `sessions.snapshot` after `sessions.added` / `sessions.removed` deltas (they refresh the counts in the next snapshot transmitted, but counts aren't pushed independently).

### Broker deltas (broker→client, when `sessions-watch` is negotiated)

#### `sessions.added` — `BrokerSessionAddedMessage`

| Field                | Type        | Description                                  |
|----------------------|-------------|----------------------------------------------|
| `sessionId`          | `SessionId` | Id of the newly observed session.            |
| `name`               | `string`    | Name of the session.                         |
| `windowCount`        | `number`    | Window count at add time (matches snapshot). |
| `attachedClientCount`| `number`    | Attached-client count at add time.           |

Shape mirrors `BrokerSessionInfo` so clients applying the delta can
maintain their session model without polling.

#### `sessions.removed` — `BrokerSessionRemovedMessage`

| Field       | Type        | Description                          |
|-------------|-------------|--------------------------------------|
| `sessionId` | `SessionId` | Id of the session that disappeared.  |

The broker reaps the daemon (if any) bound to this session before
emitting `sessions.removed`. Clients holding a stale daemon endpoint
will see their daemon connection close with `session.unavailable`
(see Daemon errors).

#### `sessions.renamed` — `BrokerSessionRenamedMessage`

| Field       | Type        | Description                  |
|-------------|-------------|------------------------------|
| `sessionId` | `SessionId` | The renamed session.         |
| `newName`   | `string`    | The new display name.        |

### Broker commands

Broker commands use a parallel `command.request` / `command.response`
envelope, structurally separate from the daemon wire's commands. The
envelope shape is identical; only the command kinds differ.

#### `command.request` — `BrokerCommandRequestMessage`

direction: client→broker

| Field           | Type            | Description                                                                 |
|-----------------|-----------------|-----------------------------------------------------------------------------|
| `correlationId` | `string`        | Client-generated opaque string, echoed in the matching response.            |
| `command`       | `BrokerCommand` | The broker operation to perform (discriminated union).                      |

#### `BrokerCommand` — discriminated union on `kind`

| `kind`              | Extra fields              | Response payload                                          |
|---------------------|---------------------------|-----------------------------------------------------------|
| `"session.claim"`   | `name: string`            | `{ sessionId, endpoint, created }` — creates session + daemon if absent |
| `"session.create"`  | `name: string`            | `{ sessionId, endpoint, created }` — fails if name in use |
| `"session.destroy"` | `sessionId: SessionId`    | `{ ok: true }` — destroys session + reaps daemon          |
| `"broker.info"`     | —                         | `{ info: BrokerInfoPayload }` — read-only diagnostics snapshot (tc-k6v) |

#### `command.response` — `BrokerCommandResponseMessage`

direction: broker→client

| Field           | Type     | Description                                              |
|-----------------|----------|----------------------------------------------------------|
| `correlationId` | `string` | Echoed from the matching request.                        |
| `result`        | union    | `{ ok: true; payload: BrokerCommandOkPayload }` on success, or `{ ok: false; code: string; message: string }` on failure. |

**`BrokerCommandOkPayload`** (per-kind):

| Kind                | Payload                                                         |
|---------------------|-----------------------------------------------------------------|
| `"session.claim"`   | `{ sessionId: SessionId; endpoint: string; created: boolean }`  |
| `"session.create"`  | `{ sessionId: SessionId; endpoint: string; created: boolean }`  |
| `"session.destroy"` | `{ ok: true }`                                                  |
| `"broker.info"`     | `{ info: BrokerInfoPayload }`                                   |

`endpoint` is an opaque connection string (unix socket path under the
v3 trust model). Clients pass it to `createDaemonTransport(endpoint)`.

`created` reports whether THIS command minted the tmux session (`true`)
or attached to a pre-existing one (`false`). The broker is the system's
single create-or-attach point, so this flag is the authority for
create-time-only client behaviour — notably profile apply (tc-3y8.2):
profiles apply exactly once, at session creation, never on attach.
A successful `session.create` always reports `created: true` (it either
mints or fails `session.name-taken`; an in-flight claim for the same
name counts as taken). Only `session.claim` can resolve either way.

#### `session.claim` semantics

- If a daemon for `name` already exists, return its endpoint
  (`created: false`).
- If `name` does not exist as a tmux session, mint one (`tmux new-session
  -d -s <name>`), then spawn a daemon bound to it, then return
  (`created: true`).
- If `name` exists as a tmux session but no daemon is bound, spawn one
  and return (`created: false` — the session pre-existed; only the
  daemon is new).

**Per-name atomicity:** concurrent `session.claim` requests with the
same `name` receive identical `{ sessionId, endpoint }` responses. The
broker serializes session creation and daemon spawn against the name so
that two clients racing each other do not produce two daemons. Requests
that join an in-flight claim receive `created: false` — exactly one
claimant observes `created: true` per session creation, so create-time
behaviour (profile apply) runs at most once even under racing claims.

#### `broker.info` semantics (tc-k6v)

Read-only diagnostics snapshot for debug surfaces (the VS Code
`tmuxcc.showBrokerInfo` command). The broker answers from its in-memory
state plus cheap synchronous tmux queries (`list-sessions`,
`list-panes -a`); nothing is mutated. Additive and non-breaking: older
brokers respond `protocol.unknown-message`.

**`BrokerInfoPayload`:**

| Field                  | Type                          | Description                                                       |
|------------------------|-------------------------------|-------------------------------------------------------------------|
| `socketName`           | `string`                      | tmux socket name the broker serves (= broker runtime-dir name).   |
| `brokerSocketPath`     | `string`                      | Absolute path of the broker's unix socket.                        |
| `brokerPid`            | `number`                      | Broker process PID.                                               |
| `uptimeMs`             | `number`                      | Milliseconds since the broker's `start()` completed.              |
| `tmuxServerPid`        | `number \| null`              | tmux server PID, or `null` if no server is running.               |
| `adoptedExistingServer`| `boolean`                     | `true` iff sessions already existed at broker start (ext-a §6.2 "adopted server"). |
| `connectedClientCount` | `number`                      | Raw IPC connection count (incl. the requesting connection).       |
| `logPath`              | `string \| null`              | Broker log file path, or `null` when started without log redirection. |
| `sessions`             | `BrokerInfoSession[]`         | Per-session diagnostics rows.                                     |

**`BrokerInfoSession`:** `{ sessionId, name, daemonPid, windowCount,
paneCount, attachedClientCount }`. `daemonPid` is `null` when no daemon
is currently running for the session (unclaimed, or crashed pending lazy
respawn). `attachedClientCount` is the raw tmux `session_attached`
value, which includes tmuxcc's own `-CC` clients (daemon + watcher) —
display surfaces must label it as raw; fixing the semantics is owned by
tc-3y8.7.

**Broker log file:** the broker entry point (`broker-entry.ts`) mirrors
the process's stderr into an append-only log file at
`<runtime>/<socketName>/broker.log` (mode 0600, no rotation — tc-k6v).
`broker.info` reports the path as `logPath`; in-process/programmatic
brokers that skip the entry point have no log file (`logPath: null`).

### Broker errors

#### `error` — `ErrorMessage` (broker wire)

Same envelope as the daemon wire's `ErrorMessage` (see "Daemon errors"
below). Broker-wire error codes:

| Code                          | Cause                                                                |
|-------------------------------|----------------------------------------------------------------------|
| `"protocol.unknown-message"`  | Unknown message type received. Message dropped.                      |
| `"protocol.malformed"`        | Parse failure.                                                       |
| `"protocol.version-mismatch"` | Handshake version mismatch.                                          |
| `"session.not-found"`         | `session.claim` or `session.destroy` named an unknown session.       |
| `"session.name-taken"`        | `session.create` requested a name already in use.                    |
| `"tmux.unavailable"`          | Underlying tmux server is gone or refusing commands.                 |
| `"internal"`                  | Unexpected broker-side error.                                        |

Future codes may be added; clients MUST treat unknown codes as opaque
strings.

### Broker lifecycle

Broker lifecycle is specified by the component-lifetime model
(`projects/tmuxcc/docs/ext-a-design-context.md` Part 6) and the broker
README ("Lifecycle" section):

- A broker is spawned lazily (detached) by the first client launcher
  that finds no broker socket; thereafter it manages its own exit —
  immediate on tmux-server death, 5-minute hysteresis on zero
  IPC-connected clients.
- Daemons are non-detached broker children and MUST die with the broker
  (PDEATHSIG on Linux, getppid-poll on macOS — enforcement: tc-2c5). A
  dead broker never leaves serving orphans; recovery is a fresh broker +
  fresh daemons against the surviving tmux state. There is no
  orphan-and-reclaim path.
- The broker is responsible for its own socket file's lifecycle; on
  exit it removes the socket.

---

## Daemon wire

The daemon wire is per-session. A connection is bound to exactly one tmux
session for its lifetime. There is no concept of "the active session"
because there is only ever one.

### Lifecycle and switch-client handling

A daemon's tmux south-side connection is `-CC attach -t <bound-session>`.
tmux may emit `%session-changed` notifications when something elsewhere
on the server changes the attached session for this `-CC` control
client (a user running `:switch-client` from another window, for
instance).

The daemon's response is narrow and recoverable when possible:

1. **Filter to this `-CC` client's own session changes.** `%session-changed`
   notifications for *other* control clients are ignored.
2. **If the new attached session equals `<bound>`:** no-op. The daemon
   is still correctly bound; the wire emits nothing.
3. **If the new attached session differs from `<bound>`:** query
   `tmux list-sessions`.
   - If `<bound>` is still present: silently issue `attach-session -t
     <bound>` on the `-CC` connection to restore the binding. Nothing
     surfaces on the wire.
   - If `<bound>` is gone from the session list: emit `ErrorMessage`
     with code `"session.unavailable"` and close all client connections
     on this daemon. The broker observes the daemon process exit and
     emits `sessions.removed` to remaining broker-wire subscribers.

This means the only *fatal* daemon-wire event for a tmuxcc client is
genuine session disappearance. Routine `switch-client` from elsewhere
is invisible.

### Multiple clients on one daemon

A single daemon can serve multiple concurrent client connections (e.g.,
two VS Code windows opening the same workspace simultaneously). Each
connection is independent:

- Each gets its own broker → daemon claim and its own daemon-wire
  transport. The broker hands out the same `endpoint` for the same
  session name; the daemon accepts multiple inbound connections on its
  socket.
- Each connection runs its own handshake, receives its own
  `SnapshotMessage` at its own seq=2, and maintains its own outgoing
  seq counter on the daemon side.
- Deltas are fan-out: a single tmux event becomes N daemon-wire deltas,
  one per connected client, each stamped with that client's per-connection
  seq.
- `attachedClientCount` in the snapshot is the count at the moment of
  snapshot construction. It is not live-broadcast on changes. Clients
  needing live counts MAY issue a fresh `resync.request` to refresh.

The daemon owns one upstream `-CC attach` connection regardless of
client count — the multi-client model is north-side only.

### Handshake

```
Client                                Daemon
  |---- transport.connect ----------->|
  |<--- daemon.capabilities (seq=1) --|   (1) daemon advertises
  |---- client.capabilities (seq=1) ->|   (2) client responds
  |                                   |
  |<--- snapshot (seq=2) -------------|   (3) initial model
  |<--- delta…   (seq=3..) -----------|   (4) live updates
```

Feature set v3 for the daemon wire:

| Feature              | Description                                         |
|----------------------|-----------------------------------------------------|
| `"pane-lifecycle"`   | Pane open/close/resize events.                      |
| `"layout-updates"`   | Structured window layout pushes.                    |
| `"focus-events"`     | Active-pane focus notifications.                    |
| `"input-forwarding"` | Client→daemon key/text input.                       |

### `daemon.capabilities` — `DaemonCapabilitiesMessage`

direction: daemon→client. Sent once at handshake. Carries `Capabilities`.

### `snapshot` — `SnapshotMessage`

direction: daemon→client. Sent once after handshake.

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

### Pane deltas (daemon→client)

#### `pane.opened` — `PaneOpenedMessage`

| Field      | Type       | Description                                          |
|------------|------------|------------------------------------------------------|
| `paneId`   | `PaneId`   | Daemon-assigned wire id for the new pane.            |
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

### Window deltas (daemon→client)

#### `window.added` — `WindowAddedMessage`

| Field      | Type       | Description                                                     |
|------------|------------|-----------------------------------------------------------------|
| `windowId` | `WindowId` | Daemon-assigned id for the new window.                          |
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

### Layout deltas (daemon→client)

#### `layout.updated` — `LayoutUpdatedMessage`

| Field      | Type           | Description                      |
|------------|----------------|----------------------------------|
| `windowId` | `WindowId`     | The window whose layout changed. |
| `layout`   | `WindowLayout` | Full current layout tree.        |

### Focus deltas (daemon→client)

#### `focus.changed` — `FocusChangedMessage`

| Field      | Type               | Description                                        |
|------------|--------------------|----------------------------------------------------|
| `paneId`   | `PaneId   \| null` | Newly focused pane, or `null` if no pane is active.|
| `windowId` | `WindowId \| null` | Window of the focused pane, or `null`.             |

### Session delta (daemon→client) — only one

#### `session.renamed` — `DaemonSessionRenamedMessage`

| Field     | Type     | Description                                |
|-----------|----------|--------------------------------------------|
| `newName` | `string` | The new display name of the bound session. |

No `sessionId` field — there's only one session. The broker emits its
own `BrokerSessionRenamedMessage` to other broker-wire subscribers.
Ordering between the broker-wire and daemon-wire rename events on a
single client is not guaranteed; clients should treat the later arrival
as canonical.

Session creation and destruction are not daemon-wire concerns. Creation
happens at the broker. Destruction surfaces as an `ErrorMessage` with
code `"session.unavailable"` and a connection close.

### Commands (daemon wire)

Commands are client-initiated model operations. The client sends a
`command.request`; the daemon sends exactly one `command.response`
correlated by `correlationId`. Side-effects arrive as normal deltas.

#### `command.request` — `DaemonCommandRequestMessage`

direction: client→daemon

| Field           | Type          | Description                                                                 |
|-----------------|---------------|-----------------------------------------------------------------------------|
| `correlationId` | `string`      | Client-generated opaque string, echoed in the matching `command.response`.  |
| `command`       | `WireCommand` | The model operation to perform.                                             |

#### `WireCommand` — discriminated union on `kind`

All commands operate within the bound session. None carry `sessionId`.

| `kind`             | Extra fields                                           | Description                                                   |
|--------------------|--------------------------------------------------------|---------------------------------------------------------------|
| `"open-window"`    | `name?`, `cwd?`, `shellCommand?`                       | Open a new window in the bound session.                       |
| `"split-pane"`     | `paneId?`, `direction: "horizontal" \| "vertical"`, `cwd?`, `shellCommand?` | Split a pane. `paneId` optional — when absent the daemon splits the current pane. |
| `"close-pane"`     | `paneId`                                               | Kill a pane.                                                  |
| `"rename-window"`  | `windowId`, `name`                                     | Rename a window.                                              |
| `"select-pane"`    | `paneId`                                               | Focus a pane.                                                 |
| `"resize-pane"`    | `paneId`, `cols`, `rows`                               | Resize a pane to explicit dimensions.                         |
| `"kill-session"`   | `sessionName: string`                                  | Kill the tmux session entirely. Daemon emits `ErrorMessage{code:"session.unavailable"}` and closes all client connections. Uses session name (not id) to avoid fragile numeric-id mapping. |

#### `command.response` — `DaemonCommandResponseMessage`

direction: daemon→client

| Field           | Type     | Description                                              |
|-----------------|----------|----------------------------------------------------------|
| `correlationId` | `string` | Echoed from the matching `command.request`.              |
| `result`        | union    | `{ ok: true; payload?: DaemonCommandOkPayload }` on success, or `{ ok: false; code: string; message: string }` on failure. |

**`DaemonCommandOkPayload`**:

| Field      | Type        | Description                                      |
|------------|-------------|--------------------------------------------------|
| `windowId` | `WindowId?` | Set by `open-window` for the newly created window.|
| `paneId`   | `PaneId?`   | Set by `open-window` and `split-pane`.            |

### Daemon errors

#### `error` — `ErrorMessage`

direction: daemon→client. Used only for errors NOT attributable to a
specific outstanding `command.request`. Command failures arrive in
`command.response` with `result.ok = false`.

| Field           | Type            | Description                                                                         |
|-----------------|-----------------|-------------------------------------------------------------------------------------|
| `code`          | `WireErrorCode` | Machine-readable error code.                                                        |
| `message`       | `string`        | Human-readable description.                                                         |
| `correlationId` | `string?`       | Optional. Ties this error to a prior request that will NOT receive a response.      |

**Daemon-wire `WireErrorCode`** values:

| Code                          | Description                                                                        |
|-------------------------------|------------------------------------------------------------------------------------|
| `"protocol.unknown-message"`  | Unknown message type received.                                                     |
| `"protocol.malformed"`        | Parse failure.                                                                     |
| `"protocol.version-mismatch"` | Version negotiation failed.                                                        |
| `"session.unavailable"`       | The bound session is no longer reachable. Connection is being closed; reconnect via broker. |
| `"internal"`                  | Unexpected daemon-side error.                                                      |

Future codes may be added; clients MUST treat unknown codes as opaque
strings.

After `"session.unavailable"` or `"protocol.version-mismatch"`, the
client must consider the connection dead. If the client wants to keep
working, it reconnects through the broker.

### Client → Daemon messages (input and viewport)

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

Daemon applies and responds with `pane.resized` delta.

#### `resync.request` — `ResyncRequestMessage`

Client requests the daemon re-send a full snapshot for this connection.
No payload beyond `type` and `seq`.

**When sent:** the client mirror detects a seq gap. **Daemon response:**
re-sends `SnapshotMessage` at the next per-connection seq (no seq reset).

Send-once-and-dedup policy:
1. On gap detect: set `resyncRequested` flag; send `resync.request` once.
2. On snapshot arrival: clear the flag.
3. While the flag is set: ignore further gap signals.
4. If a gap is detected after the snapshot delivers: escalate to
   `transport.close()`. Reconnect path goes through broker.

After a broker-mediated reconnect: the client opens a fresh daemon-wire
connection. The new connection's seq counter starts at 1, and the
`resyncRequested` flag MUST be cleared. There is no state continuity
across reconnects.

---

## Union types

```typescript
// broker-control.ts
type BrokerMessage =
  | BrokerCapabilitiesMessage
  | BrokerSnapshotMessage
  | BrokerSessionAddedMessage
  | BrokerSessionRemovedMessage
  | BrokerSessionRenamedMessage
  | BrokerCommandResponseMessage;
// ErrorMessage (type: "error") is shared between broker and daemon wires.
// It is defined in daemon-control.ts and re-used on the broker wire with
// broker-wire error codes. It is not included in the BrokerMessage union
// because the TypeScript type for ErrorMessage is identical on both wires.

type DaemonMessage =
  | DaemonCapabilitiesMessage
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
  | DaemonSessionRenamedMessage
  | DaemonCommandResponseMessage
  | ErrorMessage;                   // daemon-wire codes

type ClientMessage =
  | ClientCapabilitiesMessage       // both wires
  | BrokerCommandRequestMessage     // broker wire
  | DaemonCommandRequestMessage     // daemon wire
  | InputMessage                    // daemon wire
  | ResizeRequestMessage            // daemon wire
  | ResyncRequestMessage;           // daemon wire

type ControlMessage = BrokerMessage | DaemonMessage | ClientMessage;
```

Broker-wire and daemon-wire `command.request` / `command.response`
share the envelope shape but carry distinct command unions. The
`type: "command.request"` discriminant alone is ambiguous; in practice
clients and servers know which wire they're on from the transport, and
the `command.kind` discriminates further.

### Type guards

| Guard              | Narrows to       |
|--------------------|------------------|
| `isControlMessage` | `ControlMessage` |
| `isBrokerMessage`  | `BrokerMessage`  |
| `isDaemonMessage`  | `DaemonMessage`  |
| `isClientMessage`  | `ClientMessage`  |

`isControlMessage` is a shallow structural check (`type: string`,
`seq: number`). Use a runtime schema validator for full validation.

---

## Data plane (`src/wire/framing.ts`) — bead tc-2mq

Unchanged from v2. The data plane carries raw terminal output bytes per
pane. Binary framing — not JSON or base64 — because hot-path volumes make
escaping or inflation material.

The data-plane transport is the same per-daemon socket as the daemon
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

Sequence numbers are per-pane, owned by the daemon, starting at 0. Clients
use them to detect drops and (rarely) restore ordering.

---

## File layout

```
src/wire/
  ids.ts             — SessionId, WindowId, PaneId
  layout.ts          — WindowLayout, LayoutNode, Rect
  envelope.ts        — MessageBase, Capabilities, shared type guards
  broker-control.ts  — Broker wire control messages + BrokerCommand union
  daemon-control.ts  — Daemon wire control messages + WireCommand union
  transport.ts       — Transport seam (control + data plane multiplexed) + in-memory pair
  framing.ts         — Data-plane binary frame format (unchanged)
  handshake.ts       — Handshake helpers (shared between broker and daemon wires)
  index.ts           — Public barrel
  *.test.ts          — Per-module tests
SCHEMA.md            — This document
```

---

## Implementation status (epic tc-j9c)

All five implementation stages have shipped:

| Stage | Work | Bead |
|-------|------|------|
| 0 | Wire schema split — `envelope.ts`, `daemon-control.ts`, `broker-control.ts`, `handshake.ts` | tc-j9c.1 |
| 1 | Daemon wire → single-session; client mirror single-session migration | tc-j9c.2 |
| 2 | `tmuxcc-broker` package — broker wire, supervisor, tmux south-side | tc-j9c.3 |
| 3 | VS Code extension — broker-mediated activation flow | tc-j9c.4 |
| 4 | Test harness — per-test broker isolation | tc-j9c.5 |
| 5 | Docs pass — this reconciliation | tc-j9c.6 |

The switch-client narrowing follow-up (runtime path narrowing for `%session-changed`)
was delivered in bead tc-j9c.7.
