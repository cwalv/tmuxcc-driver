# tmuxcc wire protocol

Language-neutral specification for the tmuxcc wire protocol.  
Current version: **3** (`WIRE_PROTOCOL_VERSION = 3`).

---

## 1. Overview

tmuxcc has two wires, each with its own connection lifecycle:

| Wire | Participants | Purpose |
|------|-------------|---------|
| **server-proxy wire** | server-proxy ↔ client | Session discovery, lifecycle (create/claim/destroy), endpoint routing |
| **session-proxy wire** | session-proxy ↔ client | Terminal data and events for a single bound tmux session |

A typical client connects to the server-proxy wire first, claims (or creates) a session, receives a `endpoint` string, then connects to that endpoint to open a session-proxy wire.

---

## 2. Two planes

Every wire carries two logically distinct channels:

### 2.1 Control plane (JSON, structured)

Carries typed messages — pane lifecycle events, layout updates, input commands, capabilities. Low-volume, human-readable. Each message is a JSON object sent as a newline-terminated or length-prefixed text frame (the transport framing is transport-specific — Unix socket implementations use newline-delimited JSON; this is an implementation detail, not part of the wire contract).

Every control-plane message carries:
- `type` (string) — discriminant for narrowing
- `seq` (integer ≥ 1) — per-connection per-sender monotonically-increasing counter, starting at 1

Schemas: `schemas/` directory, one file per message family.

### 2.2 Data plane (binary frames)

Carries raw terminal output bytes for panes. High-volume; binary framing. See `schemas/data-plane-framing.json` for the frame layout.

Frame layout summary:
```
Offset  Size  Field
------  ----  -------
     0     1  MAGIC   0xCC
     1     4  SEQ     uint32 BE, per-pane counter starting at 0
     5     4  PAYLEN  uint32 BE, payload length in bytes
     9     2  IDLEN   uint16 BE, paneId UTF-8 length
    11  IDLEN  PANEID  UTF-8 paneId bytes
 11+IDLEN PAYLEN PAYLOAD  raw terminal bytes, any value
```

`MAX_FRAME = 8 MiB`. Frames with PAYLEN > MAX_FRAME are rejected before buffering.

---

## 3. Handshake (server-initiates pattern)

Both wires use the same handshake pattern: the server speaks first.

```
Server (session-proxy or server-proxy)       Client
  |                                   |
  |── <server>.capabilities ─────────▶|  (1) server advertises version + features
  |◀─ client.capabilities ────────────|  (2) client responds
  |                                   |
  | both compute:                     |
  |   agreedVersion = N (must be equal, else error)
  |   features = intersection(serverFeatures, clientFeatures)
```

**Version policy (v1–alpha):** Both sides MUST advertise the same `protocolVersion`. If they differ, the handshake FAILS immediately (`protocol.version-mismatch`). No negotiation, no downgrade. Increment `WIRE_PROTOCOL_VERSION` for any breaking schema change; bump both sides in lockstep.

**Feature negotiation:** Unknown feature strings are silently ignored. The effective feature set is the intersection of both sides' arrays. Features not in the intersection are inactive.

### 3.1 Session-proxy wire handshake

```
SessionProxy                          Client
  |── session-proxy.capabilities ───▶ |
  |◀─ client.capabilities ────────────|
  |── snapshot ──────────────────────▶|  (full-state baseline)
```

### 3.2 Server-proxy wire handshake

```
ServerProxy                           Client
  |── server-proxy.capabilities ─────▶|
  |◀─ client.capabilities ────────────|
  |── sessions.snapshot ─────────────▶|  (session list)
```

### 3.3 Client identity (D2)

The `client.capabilities` message carries an **optional durable client
identity** (`identity`, a `ClientIdentity`) on **both wires**. This is the
enabler for every *per-client* fact (binding intent, per-client size — see
§12): before D2 the wire had no notion of *which* client was connected, so a
per-client fact had no axis to hang on.

- `identity.id` — a durable string, **stable across the client's own reloads**
  (a VS Code window reload presents the same id). It is **opaque to the
  driver** and is the key later beads use to store/serve per-`(object, client)`
  facts. The VS Code client derives it from the workspace, but the wire does
  not encode host vocabulary (invariant §8.2): the derivation is a client-side
  detail.
- `identity.label` — optional, human-readable, **display-only** (never keyed on).

`identity` is a sibling of `capabilities`, not a field inside the shared
`Capabilities` object (the server also advertises `Capabilities` and has no
identity). It is **additive and optional**: a client that omits it handshakes
exactly as before, and an older proxy ignores it.

In this protocol revision identity is **carried and logged only** — no behavior
depends on it yet. Both proxies capture the connected client's identity, log it
on connect, and surface connected identities in their `server-proxy.info` /
`session-proxy.info` payloads (`info.clients[].identity`).

---

## 4. Sequencing and sync points

### 4.1 Session-proxy wire

1. **Connect** — transport opens.
2. **Handshake** — `session-proxy.capabilities` → `client.capabilities`. Versions must match.
3. **Snapshot** — session-proxy sends `snapshot` (seq=2 on session-proxy counter). This is the baseline: `session`, `windows`, `panes`, `focus`.
4. **Delta stream** — subsequent session-proxy messages (seq ≥ 3) are incremental deltas. The client applies them in seq order.
5. **Resync** — if the client detects a seq gap (`resync.request`), session-proxy re-sends a fresh `snapshot`. Session-proxy seq counter does NOT reset; subsequent deltas continue from the seq after the re-sent snapshot.
6. **Teardown** — transport closes, or session-proxy sends `error{code:"session.unavailable"}`.

**Seq counters are independent per sender per connection:**
- Session-proxy's seq and client's seq start at 1, independently.
- Server-proxy and session-proxy counters are independent even for the same underlying client.

### 4.2 Server-proxy wire

1. **Connect** — transport opens.
2. **Handshake** — `server-proxy.capabilities` → `client.capabilities`.
3. **Snapshot** — server-proxy sends `sessions.snapshot` (seq=2).
4. **Delta stream** — if `sessions-watch` is negotiated: `sessions.added`, `sessions.removed`, `sessions.renamed`.
5. **Commands** — client sends `command.request`; server-proxy responds with `command.response`. Each request gets exactly one response.

---

## 5. Request/response correlation

Both wires use a correlated command pattern:
- Client sends `command.request` with a client-generated `correlationId` (opaque string, e.g. UUID or monotonic counter string).
- Server echoes `correlationId` back in the matching `command.response`.
- **Exactly one response per request.** If the session/server dies mid-execution, the server MAY send `ErrorMessage{correlationId: ...}` to abort the in-flight command.
- The `ErrorMessage` (type `"error"`) is for **unsolicited** errors only — protocol-level failures with no in-flight command to correlate.

---

## 6. Causality tags

*Planned for W3.1 bead.* Future schema versions will add a `causeId` or similar field to `MessageBase` to allow clients to trace which command caused which delta stream. This section will be updated when W3.1 lands.

---

## 7. Protocol versioning

- `WIRE_PROTOCOL_VERSION` is a monotonically-increasing integer in `envelope.ts` (TS) and in all `Capabilities` messages.
- **Breaking changes** (field removal, type change, message removal, semantics change): increment the version. Bump both sides in lockstep.
- **Non-breaking additions** (new optional fields, new message kinds, new feature flags): no version bump needed. Old implementations silently ignore unknown fields and unknown `type` values.
- **Feature flags** are the preferred extension mechanism for new capabilities that require bilateral negotiation (e.g. `sessions-watch`, `input-forwarding`).

### Version history

| Version | Change | Bead |
|---------|--------|------|
| 1 | Initial | — |
| 2 | Added `ResyncRequestMessage` (`resync.request`) | tc-7ml.4 |
| 3 | ServerProxy wire introduced; session-proxy wire becomes single-session. Plural `sessions[]` → singular `session`. `sessionId` stripped from all deltas. `SessionAddedMessage`/`SessionChangedMessage` removed from session-proxy wire. `SessionClosedMessage` removed (destruction → `error{session.unavailable}`). Commands renamed with `SessionProxy` prefix. | tc-j9c |

---

## 8. Wire invariants

1. **No south-side tmux vocabulary**: `%output`, `%begin`/`%end`, tmux command numbers, octal escapes, and layout-string syntax MUST NOT appear on either wire.
2. **No renderer/host vocabulary**: `Pseudoterminal`, VS Code types, DOM types MUST NOT appear on either wire.
3. **Server-proxy wire**: session-level metadata only (names, counts, pids). No pane-level data.
4. **Data plane**: raw bytes are opaque; any byte value including 0x00 and invalid UTF-8 is permitted.
5. **Input messages** (`input`) carry UTF-8 strings, not tmux `send-keys` syntax.
6. **Layout** is always the structured tree (`WindowLayout`), never a tmux layout string.

---

## 9. Schema files

```
protocol/
  schemas/
    index.json                      — schema registry, protocol version
    shared/
      primitives.json               — PaneId, WindowId, SessionId, MessageBase, Capabilities, ClientIdentity, ClientFlags
      layout.json                   — Rect, LayoutNode tree, WindowLayout
    session-proxy/
      server-push.json              — session-proxy→client messages (SessionProxyMessage union)
      client.json                   — client→session-proxy messages (ClientMessage, WireCommand)
    server-proxy/
      server-push.json              — server-proxy→client messages (ServerProxyMessage union)
      client.json                   — client→server-proxy messages (ServerProxyCommand union)
    data-plane-framing.json         — binary frame format documentation
  golden/
    session-proxy-connect-snapshot.json  — minimal session-proxy connect+snapshot flow
    server-proxy-connect-snapshot.json   — server-proxy connect+claim flow
  PROTOCOL.md                       — this file
```

---

## 10. Conformance

TS implementations validate against these schemas in CI using ajv (v8).  
See `packages/session-proxy/src/wire/protocol-conformance.test.ts`.

Future non-TS implementations MUST pass the same golden transcripts. The generation direction flips for non-TS daemons — they generate types FROM these schemas (tc-5ev.1 Rust-future decision record).

---

## 11. Amendability

This package is structured for future beads to amend without breaking existing conformance tests:

- **New message kind**: add a `$def` entry and a new branch to the relevant `oneOf` union.
- **New optional field on existing message**: add to `properties` (no `required` update needed for non-breaking additions).
- **New command kind** (W2.1): add a `$def` entry to `session-proxy/client.json` `$defs/WireCommand` `oneOf`.
- **Causality tags** (W3.1): add field to `shared/primitives.json` `$defs/MessageBase`.
- **SessionEntry enrichment** (W1.3): amend `ServerProxySessionInfo` in `server-proxy/server-push.json`.
- **Per-client attach flags** (tc-4b6k.3/tc-4b6k.4): the `ClientFlags` `$def` in
  `shared/primitives.json` is the reserved slot. When `session.attach` lands
  (tc-4b6k.4) it references `ClientFlags`; the driver behavior lands in
  tc-4b6k.3. Widen the typed set (from `ignoreSize`/`readOnly`) as the parity
  map in §12 is implemented.

---

## 12. The per-client axis — parity map (D8, reserved)

The driver deliberately narrows tmux's client axis today (one `-CC` control
client stands in for N frontend clients), but the *protocol* must still carry
the axis so widening later is an implementation change, not a protocol change
(decisions `ownership-seams-decisions.md` §2.1). tc-4b6k.1 lands the **identity**
(§3.3) and the two-flag **schema slot** (`ClientFlags`); the rest of this map is
**reserved prose** — recorded here, not yet typed or carried.

| tmux per-client capability | tmux mechanism | Protocol status |
|---|---|---|
| Durable client identity | (n/a — tmuxcc concept) | **Implemented** (tc-4b6k.1): `ClientIdentity` on `client.capabilities`, both wires |
| Passive/observer attach | client flags `ignore-size`, `read-only` (`attach -r` = `read-only,ignore-size`) | **Slot typed** (tc-4b6k.1): `ClientFlags.{ignoreSize,readOnly}`. Carried by `session.attach` (tc-4b6k.4); driver behavior tc-4b6k.3 |
| Per-client size | `refresh-client -C WxH`; `window-size latest\|largest\|smallest\|manual` | Reserved: per-client size fact on the identity; owner-drives first, arbitration modes later (tc-4b6k.3) |
| Independent active pane | client flag `active-pane` | Reserved: per-client focus fact (today focus is one model triple) |
| Output pacing | client flag `pause-after=seconds` (control mode) | Reserved (note only; partially internalized by driver flow-control) |
| Lifecycle behavior | client flags `no-detach-on-destroy`, `wait-exit` | Reserved (note only; revisit with detach policy) |
| Per-member view of shared windows | session groups (`new-session -t`) | Reserved: the heavyweight future option for full per-client geometry |

**`read-only` control-mode caveat (load-bearing).** Verified in tmux source
(decisions §2.1): over control mode, `read-only` does **not** bind the `-CC`
command channel — a read-only control client is blocked from `send-keys` and
input paths but can still run any other mutating command. tmux's read-only is an
*input-authority* concept, not a *command-authority* one. Consequence: the D4
partition and any future observer tier are **driver-enforced**. The protocol may
carry a `readOnly` flag, but its authority semantics belong to the driver —
**never delegate them to tmux's flag.**
