# tmuxcc Wire Protocol — Schema Reference

**Status:** Control plane complete (Snapshot, Deltas, Commands, Errors). See TODOs for data plane and handshake sequencing.

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

Handshake flow (capability negotiation sequence) is defined by bead **tc-666** (TODO below).

---

## Versioning

**`WIRE_PROTOCOL_VERSION = 1`** (monotonically-increasing integer)

- The version is exchanged once at connection time via the capabilities handshake (see `DaemonCapabilitiesMessage` / `ClientCapabilitiesMessage`).
- It is NOT repeated in every message envelope — version negotiation happens once.
- **Increment rule**: bump only for breaking schema changes (field removal, type change, discriminant rename). Additive changes (new optional fields, new message `type` values) are non-breaking and do not require a bump.
- **Negotiation**: if daemon and client advertise different versions, the handshake flow (tc-666) determines fallback or rejection. The data shapes here are version-1 only.

---

## Snapshot + Delta model

The daemon maintains the canonical session model. Clients build a local replica using this two-phase pattern:

1. **Snapshot** (`type: "snapshot"`) — sent by the daemon immediately after the capabilities handshake. It carries the **complete current model**: all sessions, windows, panes, each window's layout, and the current focus. The client uses this to build its local model from zero.

2. **Deltas** — subsequent daemon-push messages describe incremental changes to the model (pane opened/closed, window added/renamed, session changed, layout updated, focus changed, etc.). The client applies each delta in `seq` order on top of its local replica.

The `seq` field (monotonically increasing per-sender, starting at 1) establishes ordering. The Snapshot's `seq` is the baseline; any Delta with a higher `seq` is applied on top. Clients MUST apply deltas in `seq` order and MAY use gaps to detect dropped messages.

```
daemon  ──►  client.capabilities  ──►  daemon
daemon  ◄──  daemon.capabilities  ◄──  daemon
daemon  ──►  snapshot             ──►  client (full model, seq=N)
daemon  ──►  pane.opened          ──►  client (seq=N+1)
daemon  ──►  window.renamed       ──►  client (seq=N+2)
...
client  ──►  command.request      ──►  daemon
daemon  ──►  command.response     ──►  client
```

Commands from the client (`command.request`) are correlated to their response (`command.response`) via `correlationId`. Side-effects of commands (e.g., a new pane appearing) arrive as normal deltas — the command response confirms success/failure; the delta carries the state change.

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
| client→daemon    | Client requests. Input, resize, or model-level commands sent by the client. |

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

## Capabilities

#### `daemon.capabilities` — `DaemonCapabilitiesMessage`

Sent once by the daemon at handshake time. The handshake sequence is defined by bead tc-666; this is the data shape only.

| Field          | Type           | Description                          |
|----------------|----------------|--------------------------------------|
| `capabilities` | `Capabilities` | Daemon's protocol version + features.|

#### `client.capabilities` — `ClientCapabilitiesMessage`

Sent once by the client at handshake time. Handshake sequence is bead tc-666's job.

| Field          | Type           | Description                          |
|----------------|----------------|--------------------------------------|
| `capabilities` | `Capabilities` | Client's protocol version + features.|

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

The type is open-ended (`string & Record<never, never>`) so future features can be added without breaking older parsers. Both sides advertise; the intersection is the effective feature set.

---

## Snapshot

### `snapshot` — `SnapshotMessage`

direction: daemon→client

Sent **once** by the daemon immediately after the capabilities handshake. Carries the complete current model so the client can render from zero, with no prior state required.

**Shape (normalized):** flat arrays of sessions, windows, and panes. The client joins on ids to build its local tree. This was chosen over deep nesting because (a) each collection is independently patchable by subsequent Deltas, (b) it avoids deeply nested JSON, and (c) it mirrors a natural client-side store structure.

```typescript
interface SnapshotMessage extends MessageBase {
  type: "snapshot";
  sessions: readonly SnapshotSession[];
  windows:  readonly SnapshotWindow[];
  panes:    readonly SnapshotPane[];
  focus: {
    paneId:    PaneId | null;
    windowId:  WindowId | null;
    sessionId: SessionId | null;
  };
}
```

#### `SnapshotSession`

| Field       | Type        | Description                                    |
|-------------|-------------|------------------------------------------------|
| `sessionId` | `SessionId` | Session identifier.                            |
| `name`      | `string`    | Session display name.                          |
| `active`    | `boolean`   | True if this is the currently active session.  |

#### `SnapshotWindow`

| Field      | Type           | Description                                     |
|------------|----------------|-------------------------------------------------|
| `windowId` | `WindowId`     | Window identifier.                              |
| `sessionId`| `SessionId`    | Parent session.                                 |
| `name`     | `string`       | Window display name.                            |
| `active`   | `boolean`      | True if this is the active window in its session.|
| `layout`   | `WindowLayout` | Structured pane layout tree for this window.    |

#### `SnapshotPane`

| Field      | Type        | Description                           |
|------------|-------------|---------------------------------------|
| `paneId`   | `PaneId`    | Pane identifier.                      |
| `windowId` | `WindowId`  | Parent window.                        |
| `sessionId`| `SessionId` | Parent session.                       |
| `cols`     | `number`    | Width in columns.                     |
| `rows`     | `number`    | Height in rows.                       |

#### `focus` field

The currently focused pane/window/session triple. All three are `null` if no pane is focused (e.g. no sessions exist yet).

---

## Deltas

Deltas are incremental state changes pushed by the daemon after the Snapshot. Clients apply them in `seq` order to keep their local model up to date.

### Pane deltas (daemon→client)

#### `pane.opened` — `PaneOpenedMessage`

Emitted when a new pane is created (new window, split, or any other pane-creating operation).

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

#### `pane.mode-changed` — `PaneModeChangedMessage`

Emitted when a pane enters or leaves a mode (e.g. enters copy mode, or returns to normal interactive mode).

| Field    | Type       | Description                               |
|----------|------------|-------------------------------------------|
| `paneId` | `PaneId`   | The pane whose mode changed.              |
| `mode`   | `PaneMode` | The new mode (see `PaneMode` below).      |

**`PaneMode`** values:

| Value      | Description                                                     |
|------------|-----------------------------------------------------------------|
| `"normal"` | Default interactive mode.                                       |
| `"copy"`   | Copy/scroll mode — user is browsing pane history.               |
| `"view"`   | Output is being viewed in a pager-like mode.                    |
| `string`   | Open-ended: future modes. Clients MUST treat unknown values as opaque strings. |

**Note**: tmux-internal copy-mode sub-states (vi vs emacs keybindings, cursor position) are NOT represented. This is a model-level signal only.

---

### Window deltas (daemon→client)

#### `window.added` — `WindowAddedMessage`

Emitted when a new window is created in a session.

| Field      | Type        | Description                                                           |
|------------|-------------|-----------------------------------------------------------------------|
| `windowId` | `WindowId`  | Daemon-assigned wire id for the new window.                           |
| `sessionId`| `SessionId` | Session that owns the window.                                         |
| `name`     | `string`    | Initial window name.                                                  |
| `active`   | `boolean`   | True if the new window immediately became the active window in its session. |

#### `window.closed` — `WindowClosedMessage`

Emitted when a window is closed (all panes exited or explicitly destroyed).

| Field      | Type        | Description           |
|------------|-------------|-----------------------|
| `windowId` | `WindowId`  | The closed window.    |
| `sessionId`| `SessionId` | Former parent session.|

#### `window.renamed` — `WindowRenamedMessage`

Emitted when a window is renamed.

| Field      | Type       | Description              |
|------------|------------|--------------------------|
| `windowId` | `WindowId` | The renamed window.      |
| `newName`  | `string`   | The new display name.    |

---

### Layout deltas (daemon→client)

#### `layout.updated` — `LayoutUpdatedMessage`

Emitted whenever the pane layout of a window changes. Carries the full current layout as a structured tree; clients should apply it atomically.

| Field       | Type           | Description                         |
|-------------|----------------|-------------------------------------|
| `windowId`  | `WindowId`     | The window whose layout changed.    |
| `sessionId` | `SessionId`    | Session containing the window.      |
| `layout`    | `WindowLayout` | Full current layout tree.           |

---

### Focus deltas (daemon→client)

#### `focus.changed` — `FocusChangedMessage`

Emitted when the active (focused) pane changes.

| Field       | Type                | Description                                          |
|-------------|---------------------|------------------------------------------------------|
| `paneId`    | `PaneId \| null`    | Newly focused pane, or `null` if no pane is active.  |
| `windowId`  | `WindowId \| null`  | Window of the focused pane, or `null`.               |
| `sessionId` | `SessionId \| null` | Session, or `null`.                                  |

---

### Session deltas (daemon→client)

#### `session.added` — `SessionAddedMessage`

Emitted when a new session is created. Clients that track the full session set need this to stay in sync without reconnecting.

| Field       | Type        | Description                                               |
|-------------|-------------|-----------------------------------------------------------|
| `sessionId` | `SessionId` | Daemon-assigned wire id for the new session.              |
| `name`      | `string`    | Session display name.                                     |
| `active`    | `boolean`   | True if this session immediately became the active session.|

#### `session.closed` — `SessionClosedMessage`

Emitted when a session is destroyed (detached and killed, or all windows closed).

| Field       | Type        | Description              |
|-------------|-------------|--------------------------|
| `sessionId` | `SessionId` | The destroyed session.   |

#### `session.changed` — `SessionChangedMessage`

Emitted when the user switches to a different session.

| Field                 | Type        | Description                        |
|-----------------------|-------------|------------------------------------|
| `newActiveSessionId`  | `SessionId` | The session that is now active.    |

#### `session.renamed` — `SessionRenamedMessage`

Emitted when a session is renamed.

| Field       | Type        | Description              |
|-------------|-------------|--------------------------|
| `sessionId` | `SessionId` | The renamed session.     |
| `newName`   | `string`    | The new display name.    |

---

## Commands

Commands are client-initiated model operations. The client sends a `command.request`; the daemon sends exactly one `command.response` correlated by `correlationId`. Side-effects of commands (new pane appearing, focus shifting) arrive as normal Deltas; the response only carries success/failure plus any newly-minted ids.

### Error handling split

- **Command-specific failures** (unknown pane, invalid size, permission denied) arrive in `CommandResponseMessage` with `result.ok = false`. Every `command.request` receives exactly one `command.response`.
- **Unsolicited / protocol-level errors** (malformed message, unknown message type, session died) arrive as `ErrorMessage` (`type: "error"`). If such an error IS attributable to an in-flight command (e.g. session died mid-execution), the daemon MAY include `correlationId` in the `ErrorMessage` to signal that no `command.response` will arrive for that request.

### `command.request` — `CommandRequestMessage`

direction: client→daemon

| Field           | Type          | Description                                                                 |
|-----------------|---------------|-----------------------------------------------------------------------------|
| `correlationId` | `string`      | Client-generated opaque string, echoed in the matching `command.response`.  |
| `command`       | `WireCommand` | The model operation to perform (discriminated union, see below).            |

### `WireCommand` — discriminated union on `kind`

All commands are model-level — no raw tmux command strings are exposed. The daemon translates each to the appropriate tmux operation at the south boundary.

| `kind`           | Extra fields                                       | Description                                         |
|------------------|----------------------------------------------------|-----------------------------------------------------|
| `"open-window"`  | `sessionId`, `name?`                               | Open a new window in a session. `name` is optional. |
| `"split-pane"`   | `paneId`, `direction: "horizontal"\|"vertical"`    | Split a pane. Horizontal = side-by-side; vertical = stacked. |
| `"close-pane"`   | `paneId`                                           | Kill a pane.                                        |
| `"rename-window"`| `windowId`, `name`                                 | Rename a window.                                    |
| `"select-pane"`  | `paneId`                                           | Focus a pane.                                       |
| `"resize-pane"`  | `paneId`, `cols`, `rows`                           | Resize a pane to explicit dimensions.               |

### `command.response` — `CommandResponseMessage`

direction: daemon→client

| Field           | Type     | Description                                              |
|-----------------|----------|----------------------------------------------------------|
| `correlationId` | `string` | Echoed from the matching `command.request`.              |
| `result`        | union    | `{ ok: true; payload?: CommandOkPayload }` on success, or `{ ok: false; code: string; message: string }` on failure. |

**`CommandOkPayload`** (optional success payload):

| Field      | Type        | Description                                                  |
|------------|-------------|--------------------------------------------------------------|
| `windowId` | `WindowId?` | Set by `open-window` for the newly created window.  |
| `paneId`   | `PaneId?`   | Set by `open-window` and `split-pane` for the new pane. |

---

## Errors

### `error` — `ErrorMessage`

direction: daemon→client

Unsolicited error pushed by the daemon. Used ONLY for errors that are NOT attributable to a specific outstanding `command.request`. If the error IS attributable to a command, use `CommandResponseMessage` with `result.ok = false` instead.

| Field           | Type            | Description                                                                         |
|-----------------|-----------------|-------------------------------------------------------------------------------------|
| `code`          | `WireErrorCode` | Machine-readable error code (see below).                                            |
| `message`       | `string`        | Human-readable description (English, for logging/debugging).                        |
| `correlationId` | `string?`       | Optional. If set, ties this error to a prior `command.request` that will NOT receive a `command.response`. |

**`WireErrorCode`** values:

| Code                          | Description                                                                        |
|-------------------------------|------------------------------------------------------------------------------------|
| `"protocol.unknown-message"`  | The daemon received a message type it does not recognise; the message was dropped. |
| `"protocol.malformed"`        | The daemon could not parse the message (missing required field, wrong type, etc.). |
| `"protocol.version-mismatch"` | Protocol version negotiation failed.                                               |
| `"session.unavailable"`       | The tmux session the connection was bound to has gone away unexpectedly.           |
| `"internal"`                  | Unexpected daemon-side error not attributable to a specific command.               |
| `string`                      | Open-ended for future codes. Clients MUST NOT crash on unknown codes.              |

After `"protocol.version-mismatch"` or `"session.unavailable"`, the client should consider the connection dead and attempt reconnection.

---

## Union types

| Type            | Members                                                                                                    |
|-----------------|------------------------------------------------------------------------------------------------------------|
| `DaemonMessage` | `DaemonCapabilitiesMessage \| SnapshotMessage \| PaneOpenedMessage \| PaneClosedMessage \| PaneResizedMessage \| PaneModeChangedMessage \| WindowAddedMessage \| WindowClosedMessage \| WindowRenamedMessage \| LayoutUpdatedMessage \| FocusChangedMessage \| SessionAddedMessage \| SessionClosedMessage \| SessionChangedMessage \| SessionRenamedMessage \| CommandResponseMessage \| ErrorMessage` |
| `ClientMessage` | `InputMessage \| ResizeRequestMessage \| ClientCapabilitiesMessage \| CommandRequestMessage`              |
| `ControlMessage`| `DaemonMessage \| ClientMessage`                                                                           |

---

## Type guards

| Guard              | Narrows to       |
|--------------------|------------------|
| `isControlMessage` | `ControlMessage` |
| `isDaemonMessage`  | `DaemonMessage`  |
| `isClientMessage`  | `ClientMessage`  |

`isControlMessage` checks for `type: string` and `seq: number` only — it is a shallow structural check, not a full schema validator. Use a library (e.g. zod) if full runtime validation is needed.

---

## Client → Daemon messages (input and viewport)

#### `input` — `InputMessage`

Client sends text or key input destined for a pane.

| Field    | Type     | Description                                                                 |
|----------|----------|-----------------------------------------------------------------------------|
| `paneId` | `PaneId` | Target pane.                                                                |
| `data`   | `string` | UTF-8 text to write to the pane's stdin. Special keys (e.g. cursor-up) should be pre-encoded as escape sequences by the client (e.g. `"\x1b[A"`). |

**Note**: this is NOT tmux `send-keys` syntax. The daemon writes the bytes directly to the pane's pty. The client is responsible for encoding.

#### `resize.request` — `ResizeRequestMessage`

Client requests that a pane be resized (e.g. when the host viewport changes). Distinct from `resize-pane` command: this is viewport-driven (the renderer window resized), not user-initiated.

| Field    | Type     | Description             |
|----------|----------|-------------------------|
| `paneId` | `PaneId` | Target pane.            |
| `cols`   | `number` | Requested width.        |
| `rows`   | `number` | Requested height.       |

The daemon applies the resize to tmux and responds with a `pane.resized` delta.

---

## Data plane (`src/wire/framing.ts`) — bead tc-2mq

The data plane carries raw terminal output bytes for panes. It is binary (not JSON or base64) because a busy terminal can push megabytes per second; JSON encoding would add per-byte string-escape overhead and base64 would inflate every payload by 33%. The control plane handles structured messages that are low-volume and benefit from readability; the data plane does not.

### Why binary?

At hot-path volumes (a busy terminal, fast-scrolling output, cat of a large file) the difference between raw binary and JSON/base64 framing is material:
- **JSON**: each `0xFF` byte becomes the 6-character escape `ÿ`; a 1 MB payload becomes ~6 MB on the wire, plus parsing cost.
- **base64**: every 3 raw bytes become 4 ASCII characters — 33% inflation, plus a base64 decode step.
- **Binary**: payload bytes are written as-is. The only overhead is the fixed 11-byte header plus the (typically 2–4 byte) paneId.

### Frame byte layout

Every data-plane frame is a single contiguous byte sequence:

```
Offset  Size   Type          Field     Description
------  -----  ------------  --------  ------------------------------------------
     0      1  u8            MAGIC     0xCC — magic byte for framing verification
     1      4  u32 big-endian SEQ      Per-pane monotonic sequence number
     5      4  u32 big-endian PAYLEN   Payload byte length
     9      2  u16 big-endian IDLEN    paneId UTF-8 byte length
    11  IDLEN  UTF-8 bytes   PANEID    paneId string encoded as UTF-8
11+IDLEN PAYLEN raw bytes   PAYLOAD   Raw terminal output bytes (any byte value)
```

Total frame size: `11 + IDLEN + PAYLEN` bytes.

#### Field rationale

| Field   | Size         | Rationale |
|---------|--------------|-----------|
| MAGIC   | 1 byte       | `0xCC` (mnemonic: "control-client"). Allows detection of framing errors / stream corruption. Not a valid UTF-8 start byte for common paneId strings, reducing false positives. |
| SEQ     | 4 bytes u32  | 4 billion frames per pane before wrap. At 1 MB/s of 4 KB frames, ~48 years before rollover. Wrap at `0xFFFFFFFF` is explicitly allowed; clients detect a gap of UINT32_MAX or a seq going back to 0. |
| PAYLEN  | 4 bytes u32  | Supports frames up to ~4 GB in the field, but the decoder enforces a `MAX_FRAME` cap of 8 MiB. Frames with `PAYLEN > MAX_FRAME` are rejected with a `RangeError` before any buffering or allocation; the connection must be torn down. |
| IDLEN   | 2 bytes u16  | Supports paneId UTF-8 strings up to 65535 bytes. Current ids ("p0", "s0-p3") are short; 2 bytes keeps the header compact without wasting 4. |
| PANEID  | IDLEN bytes  | PaneId encoded as UTF-8. Variable-length because PaneId is a branded string of arbitrary length (see design choice below). |
| PAYLOAD | PAYLEN bytes | Raw terminal output bytes. Opaque. May contain 0x00, 0xFF, or any byte sequence that is not valid UTF-8. NEVER base64 or escaped. |

#### PaneId encoding design choice

PaneId is a branded string (see `ids.ts`). Two options were considered for the binary header:

- **(a) Length-prefixed UTF-8 field** — encode the string directly with a 2-byte length prefix. Simple, no extra state, readable in a hex dump.
- **(b) Numeric alias** — define a numeric handle (e.g. u32) per pane, maintain a state table mapping alias ↔ PaneId. Smaller per-frame overhead for long ids; requires alias assignment/lookup.

**Choice: option (a)** — length-prefixed UTF-8. Current pane ids are 2–6 bytes ("p0"…"s0-p3"), so the overhead difference is negligible. Option (b) would add a state table the data plane does not otherwise need. If ids grow substantially longer in the future, option (b) is the natural upgrade path.

### Sequence numbers

`SEQ` is a per-pane monotonically-increasing `uint32`, **starting at 0**. The **daemon** owns the counter for each pane and increments it with every frame emitted for that pane.

Clients use the sequence number to:
- **Detect frame drops**: a gap in `seq` for the same `paneId` means one or more frames were lost.
- **Restore ordering**: if a transport delivers frames out-of-order (unlikely on a local socket, possible on a routed transport), clients can buffer and sort by seq.

`encodeFrame` accepts `seq` as a parameter; the daemon is responsible for maintaining a per-pane counter.

### API (`src/wire/framing.ts`)

```typescript
// Magic byte constant
export const FRAME_MAGIC = 0xCC;

// Decoded frame shape
export interface DataFrame {
  paneId:  PaneId;
  seq:     number;    // uint32
  payload: Uint8Array; // raw bytes; any byte value
}

// Encode a frame into a single Uint8Array
export function encodeFrame(
  paneId:  PaneId,
  seq:     number,      // uint32, per-pane counter (caller owns increment)
  payload: Uint8Array,
): Uint8Array;

// Decode a complete frame from a byte buffer (single-frame, not streaming)
export function decodeFrame(buf: Uint8Array): DataFrame;

// Stateful streaming decoder — handles chunk boundaries
export class FrameDecoder {
  push(chunk: Uint8Array): DataFrame[]; // returns all complete frames decoded
}
```

`encodeFrame` throws `RangeError` if the paneId UTF-8 encoding exceeds 65535 bytes.
`decodeFrame` and `FrameDecoder.push` throw `RangeError` on a bad magic byte or truncated buffer.

### Streaming decoder

TCP and pipe reads do not respect frame boundaries. A single `read()` call may return a partial header, exactly one frame, or multiple frames concatenated. `FrameDecoder` maintains an internal byte buffer and yields complete frames only once their full `PAYLEN` bytes have arrived. Partial frames are held across `push()` calls. Example:

```typescript
const dec = new FrameDecoder();
socket.on("data", (chunk: Uint8Array) => {
  const frames = dec.push(chunk);
  for (const frame of frames) {
    applyPaneOutput(frame.paneId, frame.seq, frame.payload);
  }
});
```

### File layout

```
src/wire/
  framing.ts       — encodeFrame, decodeFrame, FrameDecoder, DataFrame, FRAME_MAGIC
  framing.test.ts  — round-trip, non-UTF-8 bytes, streaming, error cases
```

---

## Handshake flow (bead tc-666)

The handshake establishes a shared `NegotiatedSession` — agreed protocol version + effective feature set — before any data flows.  Implementation: `src/wire/handshake.ts`.

### Sequence

**The daemon initiates.**  This follows the convention of server-first protocols (SSH server banner, SMTP server greeting): the connecting client waits to learn what the server supports before committing any state, and the daemon is always the authoritative source of truth.

```
Daemon                                  Client
  |                                       |
  |---- daemon.capabilities (seq=1) ----->|   (1) daemon advertises version + features
  |<---- client.capabilities (seq=1) -----|   (2) client responds with its own
  |                                       |
  |  both sides independently compute:   |
  |    agreedVersion  (must match)        |
  |    features = intersection(D ∩ C)    |
  |                                       |
  |---- snapshot (seq=2) ---------------->|   (3) normal data flow begins
```

Steps:
1. Immediately after transport connection is established, the daemon sends `daemon.capabilities` (seq=1).
2. The client receives it and sends `client.capabilities` (seq=1) in response.
3. Both sides independently compute the negotiated session.  If negotiation succeeds, normal data flow begins (daemon sends `snapshot`, then deltas).  If it fails, the connection is closed.

### Version-negotiation policy (v1 — alpha)

**Exact match required.**  Both sides MUST advertise the same `WIRE_PROTOCOL_VERSION`.  If `daemonCapabilities.protocolVersion !== clientCapabilities.protocolVersion`, the handshake FAILS immediately.

There is no version downgrade or fallback negotiation: this is alpha software and version bookkeeping would hide real breaking changes.  Increment `WIRE_PROTOCOL_VERSION` in `control.ts` for any breaking schema change; update both sides in lockstep.

### Feature-intersection rule

Each side advertises its supported `WireFeature[]` set independently.  The **effective feature set** after a successful handshake is the **set intersection** of the two sides' advertised arrays.  Only features present in both advertisements are considered active.

Unknown feature strings received from the remote are silently ignored (forward-compatible: a new feature added to a future peer does not cause older implementations to fail).

### Failure modes

| Code                           | Cause                                                                           |
|--------------------------------|---------------------------------------------------------------------------------|
| `"protocol.version-mismatch"`  | The two sides' `protocolVersion` values differ.                                 |
| `"protocol.unexpected-message"`| Wrong message type received during handshake (e.g. daemon gets `input` instead of `client.capabilities`). |
| `"transport.closed"`           | The transport closed before the handshake completed.                            |

All failures are represented as `HandshakeError` (typed class with a `code` field).  After any failure the caller MUST close the transport.  The `error` control-plane message with code `"protocol.version-mismatch"` may optionally be sent by the daemon before closing, so that a human-readable log appears on the client side, but this is advisory — the `HandshakeError` rejection is the authoritative signal.

### Negotiated result type

```typescript
interface NegotiatedSession {
  protocolVersion: 1;                   // agreed version (equal to WIRE_PROTOCOL_VERSION)
  features: readonly WireFeature[];     // intersection of both sides' advertised features
}
```

Post-handshake code consumes `NegotiatedSession` to know which features are safe to use.  Neither side needs to re-check capabilities after this point.

### API summary (`src/wire/handshake.ts`)

| Export                  | Description                                                     |
|-------------------------|-----------------------------------------------------------------|
| `runDaemonHandshake`    | Daemon-side: send `daemon.capabilities`, await `client.capabilities`, return `NegotiatedSession` or throw `HandshakeError`. |
| `runClientHandshake`    | Client-side: await `daemon.capabilities`, send `client.capabilities`, return `NegotiatedSession` or throw `HandshakeError`. |
| `negotiateCapabilities` | Pure function: version-check + feature intersection. Used by both sides. |
| `intersectFeatures`     | Pure function: set intersection of two `WireFeature[]` arrays.  |
| `HandshakeError`        | Typed error class with `code: HandshakeErrorCode`.              |
| `NegotiatedSession`     | Result type capturing agreed version + features.                |

---

## File layout

```
src/wire/
  ids.ts          — PaneId, WindowId, SessionId (shared with data plane)
  layout.ts       — WindowLayout, LayoutNode, Rect (structured layout tree)
  control.ts      — All control-plane message types + type guards
  transport.ts    — Transport seam (control + data plane) + in-memory pair
  framing.ts      — Data-plane binary frame format + streaming decoder (tc-2mq)
  handshake.ts    — Handshake sequence + version/feature negotiation (tc-666)
  index.ts        — Public barrel; re-exports all wire surface
  wire.test.ts    — node:test structural + type-guard tests
  transport.test.ts / framing.test.ts / handshake.test.ts — per-module tests
SCHEMA.md         — This document (repo root)
```
