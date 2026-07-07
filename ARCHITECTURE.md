# tmuxcc-driver architecture

The referenceable process and ownership model for the driver: who spawns what,
when it dies, and where the sockets live. This document owns the *cross-module*
facts the code cannot state in any one file. It links out — rather than
restating — for the wire format (`protocol/PROTOCOL.md`), the metric shapes
(`docs/observability.md`), and the tmux state analysis (`docs/state-model.md`).

Every mechanism claim below carries a `file:line` or doc citation. Line numbers
are against the tree at the time of writing; symbol names are the durable anchor.

## 1. What the driver is

tmuxcc-driver is a per-user daemon that puts a real, queryable API on tmux.
tmux's control mode (`tmux -CC`) is a notification stream plus ad-hoc command
replies, not a queryable API; the driver materializes that stream (bootstrap +
reducer) and serves a consistent model — a snapshot plus ordered deltas — to any
number of frontends over a typed wire protocol (`README.md:3-7`; category
neighbors are LSP servers and DAP adapters). It is *per-user* because its sockets
live under a per-user runtime directory (§5). **tmux is the only persistence
layer:** the driver holds no durable state of its own — a broker that dies is
replaced by a fresh broker that re-attaches (`tmux -CC`) to the tmux sessions
that survived it, and any tmuxcc-owned facts live as `@tmuxcc-*` options on tmux
objects, not in the process (`packages/driver/src/server-proxy.ts:2345-2349`;
model detail in [`docs/state-model.md`](docs/state-model.md)).

## 2. Package map

Four workspace packages. Dependency direction is downstream-references-upstream
only; nothing depends on `driver-admin` or `client`.

| Package | Path | Role | Declared deps |
|---|---|---|---|
| `@tmuxcc/protocol` | `packages/protocol/` | The language-neutral wire artifact: message/envelope types + JSON schemas. The contract everything else is built against. | none (dev-only) — `packages/protocol/package.json` |
| `@tmuxcc/driver` | `packages/driver/` | The daemon: the per-user broker (socket, session table, supervisor) plus the per-session adapter that speaks `tmux -CC`, holds the fold, and serves snapshot + deltas. | `@tmuxcc/protocol`, `node-pty`, `prom-client` — `packages/driver/package.json:40-42` |
| `@tmuxcc/client` | `clients/ts/` | The headless TypeScript host SDK — the "brain" a host (e.g. tmuxcc-vscode) embeds to talk to a broker. | `@tmuxcc/protocol`, `@tmuxcc/driver` — `clients/ts/package.json:35-36` |
| `@tmuxcc/driver-admin` | `packages/driver-admin/` | Read-only diagnostics CLI (`tmuxcc-info` bin) over a running broker. | `@tmuxcc/client`, `@tmuxcc/driver`, `@tmuxcc/protocol` — `packages/driver-admin/package.json:18-19,32-34` |

Everything depends on `@tmuxcc/protocol`; `@tmuxcc/driver` depends on nothing but
protocol; SDKs (`client`) and tooling (`driver-admin`) sit downstream. A host
product versions with its own repo and is never depended on here (`README.md:19-20`).

## 3. Process model

**One broker per (user, socket-name).** The broker — the `ServerProxy` — is the
per-socket discovery and lifecycle service (`packages/driver/src/server-proxy.ts:2`).
Its socket path, `<runtimeDir>/<socketName>/server-proxy.sock`, is fully derived
from the per-user runtime dir and the tmux socket name (§5), so there is exactly
one broker instance per user per tmux socket.

**Socket-bind-as-lock.** Singleton-per-socket is enforced by the kernel, not by a
lockfile: the unix-socket bind *is* the cross-process single-flight lock
(`server-proxy.ts:217-220`). `_bindSocketAsOwner` calls `listen()` *without*
pre-removing the socket file (`server-proxy.ts:741-750`, function doc at
`:812-826`); of two brokers racing the same path, exactly one `listen()` succeeds
and the other gets `EADDRINUSE`. On `EADDRINUSE` the loser classifies the occupant
via `classifySocketOwner` (`runtime-dir.ts:257-293`): an `"alive"`/`"inconclusive"`
occupant means a live broker already owns it (raise `ServerProxyAlreadyRunningError`,
never touch the file), a `"stale"` occupant is a dead broker's leftover (remove and
retry the bind, bounded). A self-clobber is irreversible, so it is never taken on
non-terminal evidence.

**Session-proxies run in-process.** The broker owns a supervisor that
instantiates and reaps one *session-proxy* per claimed tmux session **in-process**
— a collapse from the pre-`tc-2x3` topology where each session-proxy was its own
child process (`server-proxy.ts:20-21`;
`packages/driver/src/session-proxy-supervisor.ts:1-9` and the collapse note at
`:13-24`). A session-proxy speaks the `session-proxy` wire for a single bound
session; the supervisor serializes concurrent claims for one session name so only
one is ever created. Because session-proxies share the broker's single event loop,
a broker crash takes them with it by construction — there is no die-with-parent
watchdog and no orphan processes to reap (`server-proxy.ts:2345-2347`).

**The thin `-CC` watcher.** The broker runs one thin `tmux -CC` watcher on the
south side purely for `%sessions-changed` notifications — the trigger to re-query
the session set (`server-proxy.ts:18`). The watcher is deliberately thin: it
signals *that* the session set changed; the state fold and `tmux -CC` translation
belong to the per-session adapters and the state model
([`docs/state-model.md`](docs/state-model.md)), not here.

## 4. Lifetime & exit

**Lazy, detached spawn.** The broker does not manage its own auto-spawn — that is
a launcher's job (`server-proxy.ts:2336-2337`). The entry point
(`packages/driver/src/server-proxy-entry.ts:1-3`) is spawned as a child process
by the first client that finds no live broker at the well-known socket; it parses
args, mirrors stderr into `<runtime>/<socketName>/server-proxy.log`, starts the
broker, and writes `"READY\n"` to stdout so the launcher knows it is listening
(`server-proxy-entry.ts:26-34`). Launchers spawn it *detached* so the broker
outlives the spawner (the launch/detach mechanism is client-side; the driver only
requires that the process survive its parent).

**Idle self-exit — 5 minutes, zero clients.** With zero IPC clients for the full
grace window the broker self-exits with reason `"idle"`. The default grace is
5 minutes (`DEFAULT_IDLE_EXIT_MS = 5 * 60_000`, `server-proxy.ts:419`; timer
armed at `:1109`), overridable via `--idle-exit-ms` or `TMUXCC_IDLE_EXIT_MS`. The
refined condition is zero IPC clients **and** zero live in-process session-proxy
children (`server-proxy-entry.ts:11-14`, tc-eqgp).

**tmux-gone self-exit.** When the thin watcher EOFs, the broker runs a bounded
`tmux ls` liveness probe (`_onWatcherEof`, `server-proxy.ts:1007`). A `"gone"`
verdict — positive, terminal evidence the tmux server is gone — triggers an
immediate self-exit with reason `"tmux-gone"` (`server-proxy.ts:1022`;
reason type at `:207-211`), mirroring tmux's own `exit-empty on` semantics. A
watcher EOF whose probe *succeeds* or is inconclusive re-spawns the watcher and
keeps serving — "inconclusive ≠ gone", because a self-exit is irreversible. Both
self-exit paths unlink the broker socket file before firing `onSelfExit`
(`server-proxy.ts:27-28`, `:2342-2343`).

**No crash recovery — crashes are bugs.** There is no auto-restart layer: broker
crashes are bugs to fix, not UX to smooth over (`server-proxy.ts:2343-2344`).
Recovery is entirely re-derivation: launcher → fresh broker → fresh in-process
session-proxies on the next `session.claim` → fresh `tmux -CC attach` to the tmux
sessions that survived (`server-proxy.ts:2347-2349`). This is only safe because
tmux is the sole persistence layer (§1).

## 5. Runtime dirs & trust model

This section is docs-authoritative: it describes **our** contract — our directory
and socket modes, our namespace, our access boundary. It makes no claim about
tmux internals. All behavior is from `packages/driver/src/runtime-dir.ts`.

**Layout and namespace.** The base runtime dir is `$XDG_RUNTIME_DIR/tmuxcc` when
`XDG_RUNTIME_DIR` is set, else `/tmp/tmuxcc-<uid>` as a per-uid fallback
(`runtimeBasePath`, `runtime-dir.ts:42-50`). Under it, each tmux socket name gets
its own sub-directory, and the broker socket is
`<base>/<socketName>/server-proxy.sock` (`serverProxySocketPath`,
`runtime-dir.ts:69-77`). Using the tmux socket name as the directory makes the
path **well-known and derivable by clients without out-of-band communication** —
there is no endpoint discovery on the wire (`runtime-dir.ts:62-67`). The broker
log, the metrics-HTTP socket, and the EDH trace log share the same
per-socket-name sub-directory (`runtime-dir.ts:89-139`).

**Directory and socket modes.** Every runtime directory is created and held at
mode `0700` (`ensureDir(..., 0o700)`, `runtime-dir.ts:55-77`). The broker socket
node is chmod'd to `0600` immediately after `listen()` via `restrictSocket`
(`runtime-dir.ts:225-231`); the metrics-HTTP socket is chmod'd the same way and,
living under the same `0700` chain, is the secure default so a per-user-isolated
unix socket — never a TCP bind — is what `/metrics` exposes (`runtime-dir.ts:119-139`).

**The trust boundary is the filesystem, not the wire.** There is no
authentication in the handshake (`protocol/PROTOCOL.md` §3): access control is
entirely the `0700` directory chain plus the `0600` socket plus an ownership
check. `verifyRuntimeDir` is applied to every runtime directory and rejects it
unless it is (1) a real directory and not a symlink, (2) owned by the current uid,
and (3) free of any group/other permission bits (`mode & 0o077 === 0`)
(`runtime-dir.ts:173-208`). Silently proceeding into a directory we do not own is
a pre-creation hijack vector on the world-writable `/tmp` fallback, so any
violation aborts loudly (`runtime-dir.ts:146-148`, tc-idlp). The net contract:
**only the owning user can reach a broker or session-proxy socket, and any process
that can open the socket is trusted** — the driver makes no finer-grained
guarantee than per-user filesystem isolation.

**GC sweep.** On startup the broker sweeps stale per-socket-name directories from
the base dir (`gcStaleRuntimeDirs`, `runtime-dir.ts:365-424`). A directory is
removed when its `server-proxy.sock` does not accept a connection
(`probeLiveSocket`, `runtime-dir.ts:306-334`), or when it has no socket at all (a
crash orphan). Three guards keep the sweep safe: the current broker's own
directory is never touched (`runtime-dir.ts:382`), a live socket is never touched
(`runtime-dir.ts:404-408`), and directories younger than `minAgeMs` (default 60 s)
are skipped so a sibling broker still mid-startup is never swept
(`runtime-dir.ts:397`). Removal failures are best-effort and never abort startup.

## 6. State & ownership

The driver's own state and ownership model is documented, not restated here. The
two-plane tmux state model (control plane vs data plane; requery-on-event; the
four-store fold) lives in [`docs/state-model.md`](docs/state-model.md). The
ratified ownership and boundary decisions **D1–D9** — the shared-vs-per-client
classification, client identity on the wire, binding cardinality, the single-socket
collapse, the tmux capability model — live in
[`docs/ownership-seams-decisions.md`](docs/ownership-seams-decisions.md). The
durable-state registry (the `@tmuxcc-*` option namespace and its ownership
semantics) is the cross-repo contract in
[`protocol/state-ownership.md`](protocol/state-ownership.md).

## 7. Where the contract lives

The wire-level and semantic contract lives in `protocol/`, next to the artifacts
that enforce it, so a contract change and its schema change land in one commit:

- [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md) — the language-neutral wire spec:
  two planes, the two dialects on one socket, handshake, sequencing, correlation,
  versioning, and wire invariants.
- [`protocol/session-lifecycle.md`](protocol/session-lifecycle.md) — the normative
  session create/claim/reap ordering contract.
- [`protocol/state-ownership.md`](protocol/state-ownership.md) — the durable-state
  / ownership-semantics contract (§6).
- `protocol/schemas/`, `protocol/golden/`, `protocol/transcripts/` — the JSON
  schemas, golden connect flows, and recorded transcripts that SDKs validate
  against (`protocol/PROTOCOL.md` §9).
