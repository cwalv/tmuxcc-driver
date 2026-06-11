# tmuxcc-driver wire protocol

The seam between tmuxcc-driver and its hosts, as a first-class language-neutral
artifact. Target contents:

- JSON Schemas for every wire message (snapshot, deltas, verbs, results)
- Protocol documentation: framing, sequencing, sync points, causality tags
- Conformance material: golden transcripts a client/daemon pair must satisfy

Status: seam only — the schemas still live as TypeScript types in
`packages/session-proxy` (see tmuxcc bead tc-5ev.3 for the extraction).
The TS implementation will validate against these schemas; a future
non-TS daemon would generate types from them (direction flips).
