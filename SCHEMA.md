# tmuxcc Wire Protocol — Schema Reference

**Status:** In progress (control plane defined; see TODOs for data plane and handshake)

---

## THE WIRE CONTRACT INVARIANT

The north-facing wire protocol speaks in terms of **panes, bytes, deltas, input, resize, layout**.
It MUST NEVER leak:

- **South-facing tmux vocabulary**: no `%output`, no `%begin`/`%end`, no tmux command numbers, no octal escapes, no layout-string syntax from tmux.
- **Renderer/host vocabulary**: no `Pseudoterminal`, no VS Code types, no DOM.

The wire is the daemon's *projection of its model*, not a passthrough of tmux's control-mode syntax and not a renderer API. This is what allows either side (daemon or client) to be reimplemented in another language.

---

## Architecture overview

```
  [ tmux -CC ]  ← south side (tmux control-mode protocol)
       ↕  (daemon internal — NOT on the wire)
  [ daemon ]
       ↕  ← wire (THIS DOCUMENT)
  [ client ]
       ↕  (renderer internal)
  [ VS Code / web renderer ]
```

The wire has two planes:

| Plane         | Bead   | Description                                                      |
|---------------|--------|------------------------------------------------------------------|
| Control plane | tc-auj | Structured messages (this document). Discriminated union types.  |
| Data plane    | tc-2mq | Length-prefixed raw pane byte streams. Transport-level framing.  |

Handshake flow (capability negotiation sequence) is defined by bead **tc-auj** (TODO below).

---

## Versioning

**`WIRE_PROTOCOL_VERSION = 1`** (monotonically-increasing integer)

- The version is exchanged once at connection time via the capabilities handshake (see `DaemonCapabilitiesMessage` / `ClientCapabilitiesMessage`).
- It is NOT repeated in every message envelope — version negotiation happens once.
- **Increment rule**: bump only for breaking schema changes (field removal, type change, discriminant rename). Additive changes (new optional fields, new message `type` values) are non-breaking and do not require a bump.
- **Negotiation**: if daemon and client advertise different versions, the handshake flow (tc-auj) determines fallback or rejection. The data shapes here are version-1 only.

---

## Shared primitives (`src/wire/ids.ts`)

These types are imported by BOTH the control plane and the data plane (tc-2mq).

### `PaneId`

```typescript
type PaneId = Brand<string, "PaneId">
```

- **Representation**: opaque branded string (e.g. `"p0"`, `"p1"`).
- **Why string, not number**: strings allow future namespacing (e.g. `"s0-p3"` for multi-session reconnect) without a breaking schema change.
- **South-side mapping boundary**: the daemon maps tmux's internal `%N` pane identifiers to `PaneId` values. This mapping lives entirely inside the daemon; `%N` syntax NEVER appears on the wire.
- **Clients** treat `PaneId` as an opaque token. The daemon mints them; clients must not construct `PaneId` values independently.

### `WindowId`

Opaque branded string. Same convention as `PaneId`. Maps from tmux window index.

### `SessionId`

Opaque branded string. Same convention as `PaneId`. Maps from tmux session name/id.

---

## Direction model

| Direction        | Description                                                              |
|------------------|--------------------------------------------------------------------------|
| daemon→client    | Server push. The daemon is the source of truth; clients are subscribers. |
| client→daemon    | Client requests. Input or resize requests sent by the client.            |

Handshake messages (`daemon.capabilities`, `client.capabilities`) flow both ways at session start.

---

## Layout representation (`src/wire/layout.ts`)

tmux emits **layout strings** on its south side (e.g. `5x24,0,0[5x12,0,0,0,5x12,0,12,1]`). The daemon parses these strings internally and projects a **structured tree** onto the wire. Layout strings never appear in the wire protocol.

### `Rect`

```typescript
interface Rect {
  x: number;    // column of top-left corner, 0-based
  y: number;    // row of top-left corner, 0-based
  cols: number; // width in terminal columns
  rows: number; // height in terminal rows
}
```

### `LayoutNode` (discriminated union)

```typescript
type LayoutNode = LayoutPane | LayoutHSplit | LayoutVSplit
```

| Kind      | Description                                                   |
|-----------|---------------------------------------------------------------|
| `"pane"`  | Leaf node: a single pane occupying a `Rect`.                  |
| `"hsplit"`| Horizontal split: children arranged side-by-side (left→right).|
| `"vsplit"`| Vertical split: children stacked top-to-bottom.               |

The split kinds map to tmux's `[…]` (horizontal) and `{…}` (vertical) notation but are expressed as semantic strings, not tmux characters.

### `WindowLayout`

```typescript
interface WindowLayout {
  cols: number;        // total window width
  rows: number;        // total window height
  root: LayoutNode;    // root of the layout tree
}
```

---

## Control-plane messages (`src/wire/control.ts`)

All messages share:

```typescript
interface MessageBase {
  type: string;   // discriminant — used for TypeScript narrowing
  seq: number;    // per-connection monotonically increasing sequence number, starts at 1
}
```

The sequence number is per-sender: daemon-push messages use the daemon's counter; client-request messages use the client's counter. Clients can use it to detect dropped messages.

---

### Daemon → Client messages

#### `pane.opened` — `PaneOpenedMessage`

Emitted when a new pane is created (new window, split, or any pane-creating operation).

| Field       | Type        | Description                                         |
|-------------|-------------|-----------------------------------------------------|
| `paneId`    | `PaneId`    | Daemon-assigned wire id for the new pane.           |
| `windowId`  | `WindowId`  | Window containing the pane.                         |
| `sessionId` | `SessionId` | Session containing the window.                      |
| `cols`      | `number`    | Initial width in columns.                           |
| `rows`      | `number`    | Initial height in rows.                             |
| `active`    | `boolean`   | True if this pane is the active pane at open time.  |

#### `pane.closed` — `PaneClosedMessage`

Emitted when a pane exits or is killed.

| Field       | Type        | Description              |
|-------------|-------------|--------------------------|
| `paneId`    | `PaneId`    | The closed pane.         |
| `windowId`  | `WindowId`  | Former parent window.    |
| `sessionId` | `SessionId` | Former parent session.   |

#### `pane.resized` — `PaneResizedMessage`

Emitted after a pane's dimensions change (daemon confirmation — distinct from the client's `resize.request`).

| Field    | Type     | Description                    |
|----------|----------|--------------------------------|
| `paneId` | `PaneId` | The resized pane.              |
| `cols`   | `number` | New width in columns.          |
| `rows`   | `number` | New height in rows.            |

#### `layout.updated` — `LayoutUpdatedMessage`

Emitted whenever the pane layout of a window changes. Carries the full current layout as a structured tree; clients should apply it atomically.

| Field       | Type           | Description                         |
|-------------|----------------|-------------------------------------|
| `windowId`  | `WindowId`     | The window whose layout changed.    |
| `sessionId` | `SessionId`    | Session containing the window.      |
| `layout`    | `WindowLayout` | Full current layout tree.           |

#### `focus.changed` — `FocusChangedMessage`

Emitted when the active (focused) pane changes.

| Field       | Type              | Description                                          |
|-------------|-------------------|------------------------------------------------------|
| `paneId`    | `PaneId \| null`  | Newly focused pane, or `null` if no pane is active.  |
| `windowId`  | `WindowId \| null`| Window of the focused pane, or `null`.               |
| `sessionId` | `SessionId \| null` | Session, or `null`.                                |

#### `daemon.capabilities` — `DaemonCapabilitiesMessage`

Sent once by the daemon at handshake time. The handshake sequence is defined by bead tc-auj; this is the data shape only.

| Field          | Type           | Description                         |
|----------------|----------------|-------------------------------------|
| `capabilities` | `Capabilities` | Daemon's protocol version + features.|

---

### Client → Daemon messages

#### `input` — `InputMessage`

Client sends text or key input destined for a pane.

| Field    | Type     | Description                                                                 |
|----------|----------|-----------------------------------------------------------------------------|
| `paneId` | `PaneId` | Target pane.                                                                |
| `data`   | `string` | UTF-8 text to write to the pane's stdin. Special keys (e.g. cursor-up) should be pre-encoded as escape sequences by the client (e.g. `"\x1b[A"`). |

**Note**: this is NOT tmux `send-keys` syntax. The daemon writes the bytes directly to the pane's pty. The client is responsible for encoding.

#### `resize.request` — `ResizeRequestMessage`

Client requests that a pane be resized (e.g. when the host viewport changes).

| Field    | Type     | Description             |
|----------|----------|-------------------------|
| `paneId` | `PaneId` | Target pane.            |
| `cols`   | `number` | Requested width.        |
| `rows`   | `number` | Requested height.       |

The daemon applies the resize to tmux and responds with a `pane.resized` message.

#### `client.capabilities` — `ClientCapabilitiesMessage`

Sent once by the client at handshake time. Handshake sequence is bead tc-auj's job.

| Field          | Type           | Description                          |
|----------------|----------------|--------------------------------------|
| `capabilities` | `Capabilities` | Client's protocol version + features.|

---

### Capabilities shape (`Capabilities`)

```typescript
interface Capabilities {
  protocolVersion: 1;                  // must match WIRE_PROTOCOL_VERSION
  features: readonly WireFeature[];    // feature flags this endpoint supports
}
```

**`WireFeature`** values (v1):

| Feature              | Description                                         |
|----------------------|-----------------------------------------------------|
| `"pane-lifecycle"`   | Pane open/close/resize events.                      |
| `"layout-updates"`   | Structured window layout pushes.                    |
| `"focus-events"`     | Active-pane focus notifications.                    |
| `"input-forwarding"` | Client→daemon key/text input.                       |

The type is open-ended (`string & Record<never, never>`) so future features can be added without breaking older parsers. Both sides advertise; the intersection is the effective feature set. Negotiation logic is tc-auj's responsibility.

---

### Union types

| Type            | Members                                                                                                    |
|-----------------|------------------------------------------------------------------------------------------------------------|
| `DaemonMessage` | `PaneOpenedMessage \| PaneClosedMessage \| PaneResizedMessage \| LayoutUpdatedMessage \| FocusChangedMessage \| DaemonCapabilitiesMessage` |
| `ClientMessage` | `InputMessage \| ResizeRequestMessage \| ClientCapabilitiesMessage`                                        |
| `ControlMessage`| `DaemonMessage \| ClientMessage`                                                                           |

---

### Type guards

| Guard              | Narrows to       |
|--------------------|------------------|
| `isControlMessage` | `ControlMessage` |
| `isDaemonMessage`  | `DaemonMessage`  |
| `isClientMessage`  | `ClientMessage`  |

`isControlMessage` checks for `type: string` and `seq: number` only — it is a shallow structural check, not a full schema validator. Use a library (e.g. zod) if full runtime validation is needed.

---

## TODO: Data plane (bead tc-2mq)

The data plane carries raw pane byte streams using length-prefixed framing. It imports `PaneId` from `src/wire/ids.ts` to tag frames. The framing format, frame header layout, and stream multiplexing are defined by bead **tc-2mq**.

> **Stub**: document data-plane frame format here once tc-2mq is complete.

---

## TODO: Handshake flow (bead tc-auj)

The handshake sequence — who sends capabilities first, version-mismatch handling, fallback negotiation — is defined by bead **tc-auj**. The data shapes (`Capabilities`, `DaemonCapabilitiesMessage`, `ClientCapabilitiesMessage`) are defined in this document (control plane).

> **Stub**: document handshake sequence here once tc-auj is complete.

---

## File layout

```
src/wire/
  ids.ts        — PaneId, WindowId, SessionId (shared with data plane)
  layout.ts     — WindowLayout, LayoutNode, Rect (structured layout tree)
  control.ts    — All control-plane message types + type guards
  index.ts      — Public barrel; re-exports all wire surface
  wire.test.ts  — node:test structural + type-guard tests
```
