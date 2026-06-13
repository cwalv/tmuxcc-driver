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

- **golden/** — schema-conformance material (every message validates against the schemas)
  - `session-proxy-connect-snapshot.json` — session-proxy connect + snapshot flow
  - `server-proxy-connect-snapshot.json` — server-proxy connect + session.claim flow

- **transcripts/** — BEHAVIORAL conformance transcripts (tc-ozk.4). Replayable
  scripts of a full session-proxy wire conversation (handshake, snapshot + deltas,
  verbs + effect ids + origin, pane.capture). Each is replayed against BOTH the
  TS SDK's parser/mirror AND the real session-proxy daemon, so both ends are
  pinned to the protocol. The format is a superset of `golden/` adding an
  `initialModel` (daemon snapshot seed) and `verbs` (per-correlationId effect ids
  + model mutation). Any future SDK (lua/python) or daemon runs against these.
  - `session-proxy-verbs-capture.json` — open-window verb + pane.capture
  - `session-proxy-split-pane.json` — split-pane verb

- **PROTOCOL.md** — framing, sequencing, sync points, versioning, wire invariants

## Conformance

Two layers run in CI:

- **Schema conformance** — every wire message + golden transcript validates
  against the JSON Schemas:
  `packages/session-proxy/src/wire/protocol-conformance.test.ts`
- **Behavioral conformance** (tc-ozk.4) — the `transcripts/` are replayed against
  BOTH the SDK parser/mirror and the REAL session-proxy daemon (no live tmux):
  `clients/ts/src/harness/conformance.test.ts`. The harness lives in the SDK
  package (`@tmuxcc/client/harness`); it is the package that can see both ends.

Future non-TS daemons generate types FROM these schemas (direction flips — tc-5ev.1)
and run against the same `transcripts/`.

## Version

Current: **3** (`WIRE_PROTOCOL_VERSION = 3`, tc-j9c)
