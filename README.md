# remux

A stateful protocol adapter that puts a real API on tmux. tmux's control mode
(`-CC`) is a notification stream plus ad-hoc command replies, not a queryable
API; remux materializes the state (bootstrap + reducer) and serves a
consistent model — snapshot + ordered deltas — to any number of frontends.
Category neighbors: LSP servers and DAP debug adapters.

## Layout

- `protocol/` — the wire protocol as a first-class, language-neutral artifact:
  schemas, docs, conformance material. Implementations validate against it
  (TS today) or generate from it (possible future Rust daemon).
- `packages/server-proxy/` — per-server broker: owns the socket, supervises
  session-proxies, multiplexes clients.
- `packages/session-proxy/` — per-session adapter: speaks `tmux -CC`, holds
  the fold, serves snapshot + deltas.
- `clients/ts/` — `@remux/client`, the TypeScript host SDK.

SDKs version with the protocol and live here; hosts (e.g. tmuxcc-vscode)
version with their product and live in their own repos.

## History

Consolidated 2026-06-11 from three repos via git subtree (histories
preserved): tmuxcc-client, tmuxcc-server-proxy, tmuxcc-session-proxy.
