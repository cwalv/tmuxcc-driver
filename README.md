# tmuxcc-driver

A stateful protocol adapter that puts a real API on tmux. tmux's control mode
(`-CC`) is a notification stream plus ad-hoc command replies, not a queryable
API; tmuxcc-driver materializes the state (bootstrap + reducer) and serves a
consistent model — snapshot + ordered deltas — to any number of frontends.
Category neighbors: LSP servers and DAP debug adapters.

## Layout

- `protocol/` — the wire protocol as a first-class, language-neutral artifact:
  schemas, docs, conformance material. Implementations validate against it
  (TS today) or generate from it (possible future Rust daemon).
- `packages/driver/` — `@tmuxcc/driver`: the combined in-process runtime;
  per-server broker (socket, session table, supervisor) + per-session adapter
  (speaks `tmux -CC`, holds the fold, serves snapshot + deltas).
- `clients/ts/` — `@tmuxcc/client`, the TypeScript host SDK.

SDKs version with the protocol and live here; hosts (e.g. tmuxcc-vscode)
version with their product and live in their own repos.

## Testing policy — real-tmux suites

`packages/driver/src/runtime/` contains timing-sensitive real-tmux suites
(`flow-load.test.ts`, `resilience.test.ts`).  A flake in these suites is a
**correctness signal, not noise**.  The flake-is-a-bug rule: never mark a
real-tmux failure as noise; find and fix the race.  Run with
`--test-concurrency=1` for the `test:real-tmux` step; the `soak` script
wraps N runs to surface intermittent failures.

## History

Consolidated 2026-06-11 from three repos via git subtree (histories
preserved): tmuxcc-client, tmuxcc-server-proxy, tmuxcc-session-proxy.
