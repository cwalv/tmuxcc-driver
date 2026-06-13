# tmuxcc-driver wire protocol

The seam between tmuxcc-driver and its hosts, as a first-class language-neutral artifact.

See [PROTOCOL.md](PROTOCOL.md) for the full specification.

## Contents

- **schemas/** — JSON Schemas covering every wire message (JSON Schema 2020-12)
  - `shared/primitives.json` — PaneId, WindowId, SessionId, MessageBase, Capabilities
  - `shared/layout.json` — Rect, LayoutNode tree, WindowLayout
  - `session-proxy/server-push.json` — all session-proxy→client messages
  - `session-proxy/client.json` — all client→session-proxy messages and WireCommand
  - `server-proxy/server-push.json` — all server-proxy→client messages
  - `server-proxy/client.json` — all client→server-proxy messages and ServerProxyCommand
  - `data-plane-framing.json` — binary frame format documentation
  - `index.json` — schema registry, protocol version

- **golden/** — conformance material (clients and daemons must satisfy these)
  - `session-proxy-connect-snapshot.json` — session-proxy connect + snapshot flow
  - `server-proxy-connect-snapshot.json` — server-proxy connect + session.claim flow

- **PROTOCOL.md** — framing, sequencing, sync points, versioning, wire invariants

## Conformance

The TS implementation validates against these schemas in CI:
`packages/session-proxy/src/wire/protocol-conformance.test.ts`

Future non-TS daemons generate types FROM these schemas (direction flips — tc-5ev.1).

## Version

Current: **3** (`WIRE_PROTOCOL_VERSION = 3`, tc-j9c)
