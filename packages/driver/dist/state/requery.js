/**
 * Requery engine — events-as-invalidation topology pipeline (tc-128.1).
 *
 * @module state/requery
 *
 * # Why this exists
 *
 * The reducer (tc-5dd) interprets each tmux notification to mutate the model
 * incrementally; that path is the source of every tc-3y8 bug (window-add
 * attribution, unlinked-window phantoms, the 3.4 layout-change gap, multi-line
 * gluing). state-model.md §6 (adopted 2026-06-10, decision tc-5ym) replaces
 * that with: demote every notification to a dirty bit; on dirty, requery
 * (`list-windows` + `list-panes`, ~0.5 ms round-trip), diff against the
 * previous model, emit deltas. Bootstrap, reconnect, and steady state become
 * one path: a diff against the empty model is a bootstrap; a diff against the
 * last-served model is a reconnect; a diff against the previous in-memory
 * model is steady state.
 *
 * # Scope of this bead (tc-128.1)
 *
 * - Pure `requeryDiff(prev, windowsResult, panesResult)` core: parse the
 *   bootstrap-format replies, build a fresh model via `buildInitialModel`,
 *   diff against `prev`, return `{ next, deltas }`.
 * - `RequeryEngine`: the driver. Owns the previous model; exposes a single
 *   `requery()` method that issues both `list-*` commands, awaits both,
 *   computes the diff, and atomically swaps in the new model. Handles the
 *   "two commands — not atomic" case via a dirty bit: a `markDirty()` call
 *   that lands while a requery is in flight causes the cycle to re-run on
 *   completion (converges).
 *
 * # What is NOT in scope (left for later beads)
 *
 * - **No coalescing / rate limiting.** tc-128.2 wraps this engine with a 1 Hz
 *   leading-edge coalescer. The engine itself runs immediately when called.
 * - **No output-before-topology buffering.** tc-128.3 owns that.
 * - **No reducer retirement.** tc-128.4 retires the reducer's event
 *   interpretation. Until then, the reducer path stays alive and functioning;
 *   this engine is additive.
 * - **No pipeline wiring.** The integration with `RuntimePipeline` is a
 *   downstream concern; this bead lands the building blocks.
 *
 * # Dead-pane semantics
 *
 * tmux's `list-panes` is authoritative for pane presence: a pane with
 * `remain-on-exit on` that has died is still listed (it has a dead process
 * but the pane container exists), so it stays in the model. A pane that has
 * exited fully (no remain-on-exit) is gone from `list-panes` and is therefore
 * removed by the diff — emitting `pane.closed`. This matches the existing
 * reducer behavior, because today the reducer's `handleLayoutChange` uses
 * the new layout's leaf set as the authoritative pane membership; layout
 * absence and `list-panes` absence are the same signal (tmux reflows the
 * layout when a pane is removed). The dead-pane reducer test suite remains
 * the contract: a pane that appears in `list-panes` survives, one that
 * doesn't is closed.
 *
 * tc-4bv2 / tc-295a.10 (shared pane-state shape): a surviving corpse is not
 * silent. The bootstrap requery reads `#{pane_dead}` / `#{pane_dead_status}`
 * (bootstrap.ts), so the model's `Pane.dead` / `Pane.exitCode` carry the
 * corpse state. The diff (projection.ts) therefore emits `pane.dead-changed`
 * when a live pane becomes a corpse in place, includes the dead flag on
 * `pane.opened` for a corpse seen for the first time, and carries the corpse's
 * `exitCode` through to `pane.closed` when the slot is finally reaped. This is
 * what lets an all-dead-pane session enter the snapshot and signal READY
 * (tc-4bv2) without weakening the "in list-panes ⇒ in model" rule above.
 *
 * # Reparenting (break-pane)
 *
 * `break-pane` keeps the pane id (`%N` unchanged) but moves it to a new
 * window. Because the model and the wire use stable ids, the diff sees this
 * mechanically as: same paneId present in both `prev` and `next`, but with a
 * different `windowId`. `diffModel` emits a dedicated `pane.moved` delta
 * (tc-4gor) carrying the pane's new `windowId` — the SINGLE wire signal that
 * re-points an existing pane's window membership. There is NO pane.closed +
 * pane.opened pair, so clients keep the pane's scrollback / dimensions / mode /
 * title / dead-state — the pane was moved, not recreated. The new window is
 * announced by `window.added` first (delta-ordering rule), then `pane.moved`
 * re-homes the existing pane into it.
 *
 * NOTE (tc-4gor): the `layout.updated` deltas alone are NOT sufficient. tmux 3.4
 * emits `%layout-change` for the OLD window but NOT for the detached new window,
 * and a layout tree never re-points a pane's owner anyway; a client that derives
 * window→pane grouping from `pane.windowId` (the Mirror's ClientModel, hence the
 * VS Code side-tree) MUST get `pane.moved` or it renders the new window empty
 * with the pane stuck under its old window (stable-wrong until a resnapshot).
 * See the reparenting round-trip test in requery.test.ts.
 *
 * # Convergence under mid-flight dirties (commit-only-clean, tc-128.5)
 *
 * `requery()` issues two commands and awaits both. Between them, tmux may
 * emit notifications signalling further topology changes. The engine exposes
 * `markDirty()`: callers (the dirty-bit coalescer in tc-128.2 — for now the
 * pipeline or tests) flip the bit whenever a topology-relevant notification
 * arrives.
 *
 * The engine drives a BOUNDED convergence loop inside one `requery()` call,
 * with two non-negotiable invariants:
 *
 * 1. **Commit only clean snapshots.** A candidate model is held in a local
 *    until a cycle completes with BOTH replies ok AND the dirty bit still
 *    clear. Only then is `this._model` swapped to the candidate and the
 *    cumulative deltas (against the pre-call model) returned. Possibly-torn
 *    intermediate models are never observable through `getModel()`, and the
 *    served deltas always describe the exact `getModel()` transition.
 * 2. **Bounded budget.** Convergence is capped at `CYCLE_BUDGET` iterations.
 *    Under a sustained notification storm (every cycle dirties mid-flight)
 *    the loop exits within the budget rather than spinning at cycle-rate.
 *    On budget exhaustion the engine treats the call as failed (re-arms
 *    dirty, returns `{ next: startModel, deltas: [], failed: true }`); the
 *    coalescer's existing failed-path schedules a retry at the next ceiling
 *    boundary and the heartbeat guarantees eventual convergence.
 *
 * On `%error` from either reply the cycle is also failed: model unchanged,
 * dirty re-armed, `failed: true`. The pure-core `requeryDiff` retains its
 * BOOTSTRAP semantic ("missing rows = empty rows"); the engine's driver path
 * never wipes the model on a transient command failure.
 *
 * The short-burst case is preserved: a single mid-flight dirty followed by a
 * clean cycle converges in-call and serves the cumulative deltas. Storms
 * (the tc-3y8.8 class, ~8000 notif/s) are bounded operationally by the
 * coalescer's 1 Hz ceiling and structurally by this engine's per-call
 * cycle budget.
 *
 * # Teardown-confirmation guard (tc-3si.2)
 *
 * The tc-128.4 bug class is "a garbage `list-*` reply parsed as an EMPTY
 * windows/panes set" — the canonical example is a `%pause` ack body
 * mis-bound onto a `list-windows` slot, producing zero rows and a candidate
 * model that closes every pane and window. Slots (tc-128.4 / tc-3si.1)
 * close the known reproducer at the source by making slot-registration
 * atomic with the write. The guard here is the SECOND line of defense:
 * any future regression of the class — anything that lets a garbage
 * snapshot reach the candidate-build step — is converted from catastrophe
 * (mass `pane.closed` / `window.closed` to every client) into a ~1 ms
 * self-heal AND an expected-zero counter trip.
 *
 * The guard's algorithm: a clean cycle whose candidate would close ≥
 * `teardownThreshold` (default 0.8) of the previous model's panes OR
 * windows is NOT committed immediately. The engine holds the candidate
 * and runs one CONFIRMING cycle.
 *
 *   - Confirming cycle's candidate ALSO crosses the threshold (against the
 *     same pre-call startModel): the teardown is real. Commit the
 *     CONFIRMING cycle's candidate (not the first one — tmux may have
 *     changed slightly between them), bump
 *     `requery_teardown_confirmations_total{outcome="confirmed"}`, return
 *     deltas as usual. The user pays one extra `list-*` round-trip
 *     (~0.5–1 ms) on a genuine session-end — a rare, user-driven event.
 *
 *   - Confirming cycle's candidate DOES NOT cross the threshold (it
 *     disagrees with the first one): the first snapshot was garbage.
 *     Discard both candidates, leave `_model` untouched, re-arm the dirty
 *     bit, return `failed: true`. Bump
 *     `requery_teardown_confirmations_total{outcome="refuted"}` AND log
 *     loudly to stderr with the candidate's teardown breakdown — the
 *     storm-alarm-style alert path (`metrics/storm-alarm.ts` pattern).
 *
 * # Budget interaction (the bd-comment design call)
 *
 * The confirmation cycle COUNTS against `CYCLE_BUDGET` — same iteration
 * counter as the convergence loop. Decision rationale: every cycle is one
 * `submit()` round-trip in the same `requery()` call, the budget exists to
 * structurally bound that, and exempting the confirm would re-introduce
 * an unbounded path. With the default budget of 5 there is plenty of
 * headroom: a real cycle, one mid-flight dirty re-run, and a confirming
 * cycle all fit comfortably. If the budget is exhausted MID-CONFIRMATION
 * the engine returns `failed: true` with no commit — same shape as the
 * storm-exhaustion path; the coalescer's retry + heartbeat eventually
 * re-evaluates. The teardown counter is NOT incremented in that case
 * (we never reached a confirm-vs-refute decision).
 *
 * The masking-risk reading (operator question, 2026-06-11): the refuted
 * counter inverts the usual error-absorbing-guard concern — this guard
 * protects clients from the catastrophic symptom AND makes the underlying
 * bug class MORE visible than today, because today a single mis-bound
 * teardown is silent on the metrics side (clients see a flash and recover
 * on the next requery; nothing fires loud). With the counter every
 * incident lands one stderr line + one expected-zero counter increment.
 */
import { emptyModel } from "./model.js";
import { diffModel } from "./projection.js";
import { bootstrapCommands, buildInitialModel, parsePanesReply, parseWindowsReply, } from "./bootstrap.js";
/**
 * Parse a windows + panes reply pair into a fresh `SessionModel` and compute
 * the wire deltas needed to transform `prev` into that model.
 *
 * This is the pure core of the engine: no I/O, no state, no timing. It is
 * what makes "bootstrap = diff against empty model" and "reconnect = diff
 * against last-served model" mechanical. Pass `emptyModel()` for `prev` to
 * get the full snapshot's worth of deltas (a cold attach); pass the
 * last-served model to get the minimal deltas needed for a reconnecting
 * client.
 *
 * If either reply is `%error` the corresponding rows are treated as empty —
 * the same fallback the bootstrap coordinator uses. A double `%error`
 * produces `next === emptyModel()` and deltas closing whatever was in
 * `prev`. Callers that want to ignore failed requeries should check
 * `ok`-ness BEFORE handing the replies to this function.
 *
 * @param prev               Previous model (use `emptyModel()` for bootstrap).
 * @param windowsResult      Reply from `list-windows -F BOOTSTRAP_WINDOWS_FORMAT`.
 * @param panesResult        Reply from `list-panes  -F BOOTSTRAP_PANES_FORMAT`.
 * @returns                  `{ next, deltas }` — the new model and wire deltas.
 */
export function requeryDiff(prev, windowsResult, panesResult) {
    const windowRows = windowsResult.ok ? parseWindowsReply(windowsResult.body) : [];
    const paneRows = panesResult.ok ? parsePanesReply(panesResult.body) : [];
    const next = carryForwardBoundClients(prev, buildInitialModel(windowRows, paneRows));
    const deltas = diffModel(prev, next);
    return { next, deltas };
}
/**
 * Carry per-client binding intent forward across a requery cycle (D3,
 * tc-4b6k.2).
 *
 * `buildInitialModel` rebuilds the model from the bulk `list-*` replies, which
 * deliberately do NOT read the per-(pane,client) `@tmuxcc-bound-<key>` options
 * (the bulk session-scoped requery has no notion of the client set). So a fresh
 * candidate pane always has an EMPTY `boundClients`. This copies a surviving
 * pane's set from `prev` into the candidate, so a requery cycle never clobbers
 * binding intent that was reconstructed on connect (pipeline.applyClientBinding)
 * or applied optimistically (input-path's set-object-policy). A brand-new pane
 * (absent from `prev`) keeps its empty set; a pane whose `prev` set was already
 * empty is left as-is (preserving reference-equality for the common case).
 */
function carryForwardBoundClients(prev, candidate) {
    let changed = false;
    const panes = new Map(candidate.panes);
    for (const [id, pane] of candidate.panes) {
        const prevPane = prev.panes.get(id);
        if (prevPane !== undefined && prevPane.boundClients.size > 0) {
            panes.set(id, { ...pane, boundClients: prevPane.boundClients });
            changed = true;
        }
    }
    return changed ? { ...candidate, panes } : candidate;
}
/**
 * Create a `RequeryEngine`. See `RequeryEngine` for the lifecycle contract.
 */
export function createRequeryEngine(opts) {
    return new RequeryEngineImpl(opts);
}
class RequeryEngineImpl {
    _model;
    /**
     * The (mutable) session name supplied at construction. Used ONLY to scope
     * the very first cold cycle by `=<name>`, before any reply has revealed the
     * immutable session id. Once `_sessionId` is captured the name is never a
     * query target again (tc-0v59) — it lives on only as the human display label
     * inside the model.
     */
    _sessionName;
    /**
     * The IMMUTABLE tmux session id (`$N` → N) this engine is bound to, captured
     * from the first successful requery reply. `undefined` until that capture.
     * Once set, EVERY cycle targets `$<id>` — which survives a rename-session,
     * unlike the name. This is the fix for tc-0v59: a rename no longer makes the
     * requery target a stale name and bail with `%error`.
     */
    _sessionId;
    _submit;
    _teardownThreshold;
    _onTeardownConfirmation;
    _onTeardownOutcome;
    _onCycleFailed;
    _onBudgetExhausted;
    /** True iff `markDirty()` has been called since the last completed cycle. */
    _dirty = false;
    /**
     * In-flight cycle promise, or null if idle. Concurrent `requery()` calls
     * latch onto this promise; we never run two cycles in parallel.
     */
    _inFlight = null;
    constructor(opts) {
        this._model = opts.initialModel ?? emptyModel();
        this._sessionName = opts.sessionName;
        this._submit = opts.submit;
        // tc-3si.2: clamp threshold to (0, 1]; invalid values fall back to the
        // default. Keeps a typo (e.g. 0, -1, 200) from disabling the guard or
        // tripping it on every cycle.
        const t = opts.teardownThreshold;
        this._teardownThreshold =
            typeof t === "number" && t > 0 && t <= 1 ? t : DEFAULT_TEARDOWN_THRESHOLD;
        this._onTeardownConfirmation = opts.onTeardownConfirmation;
        this._onTeardownOutcome = opts.onTeardownOutcome;
        this._onCycleFailed = opts.onCycleFailed;
        this._onBudgetExhausted = opts.onBudgetExhausted;
    }
    getModel() {
        return this._model;
    }
    setModel(model) {
        this._model = model;
    }
    markDirty() {
        this._dirty = true;
    }
    isDirty() {
        return this._dirty;
    }
    /**
     * The session scope for the next cycle's `bootstrapCommands` (tc-0v59).
     *
     * Prefers the immutable id (`$<id>`) once captured — that's the steady-state
     * target that survives a rename. Falls back to the construction-time name
     * (`=<name>`) for the very first cold cycle, before any reply has revealed
     * the id. Returns `undefined` (→ `-a` all-sessions) when neither is known.
     */
    _sessionTarget() {
        if (this._sessionId !== undefined) {
            return { kind: "id", sessionId: this._sessionId };
        }
        if (this._sessionName !== undefined && this._sessionName.length > 0) {
            return { kind: "name", sessionName: this._sessionName };
        }
        return undefined;
    }
    /**
     * Capture the immutable session id from a parsed reply, once (tc-0v59).
     *
     * The id is field [0] of every BOOTSTRAP_*_FORMAT row. We read it from the
     * windows reply first (panes as a fallback when the session has no windows
     * in the reply yet). Once set, the id is NEVER overwritten — it is immutable
     * for the life of the session, and re-binding it could let a transient
     * cross-session contamination hijack the requery target.
     *
     * No-op when the engine has no name/id scope at all (the `-a` fallback case):
     * in that mode the engine deliberately tracks every session, so latching onto
     * one id would silently narrow the scope.
     */
    _captureSessionId(windowRows, paneRows) {
        if (this._sessionId !== undefined)
            return;
        // Only bind when this engine is scoped to a single session. In the
        // unscoped `-a` mode (no name supplied) we must NOT collapse onto one id.
        if (this._sessionName === undefined || this._sessionName.length === 0)
            return;
        const first = windowRows[0] ?? paneRows[0];
        if (first !== undefined) {
            this._sessionId = first.tmuxSessionId;
        }
    }
    requery() {
        if (this._inFlight !== null)
            return this._inFlight;
        const startModel = this._model;
        this._inFlight = this._runCycles(startModel).finally(() => {
            this._inFlight = null;
        });
        return this._inFlight;
    }
    /**
     * Run requery cycles until one completes clean (replies ok AND no
     * mid-flight dirty), then either commit the candidate to `_model` and
     * return cumulative deltas against `startModel`, or — when the candidate
     * trips the teardown-confirmation guard (tc-3si.2) — run one further
     * confirming cycle before committing. Bounded by `CYCLE_BUDGET`.
     *
     * Each cycle:
     *   1. Clear the dirty bit (notifications during this cycle re-arm it).
     *   2. Issue both `list-*` commands and await both replies.
     *   3. If either reply is `%error` (regardless of mid-flight dirties):
     *      treat the entire call as failed. Do NOT swap `_model`; re-arm the
     *      dirty bit; loud-log the incident (tc-0v59 — `_reportRequeryError`,
     *      same alarm pattern as the budget/refuted siblings); return
     *      `{ next: startModel, deltas: [], failed: true }`. The pure-core
     *      `requeryDiff` retains the BOOTSTRAP "missing rows = empty rows"
     *      semantic; the engine driver must never wipe the model on a transient
     *      command failure (a teardown burst that the next successful cycle
     *      would have to undo).
     *   4. Parse the replies into a CANDIDATE model held in a local. Do NOT
     *      write `_model` yet.
     *   5. If the dirty bit was set during this cycle: discard the candidate
     *      and loop.
     *   6. Otherwise (clean cycle), check the teardown-confirmation guard:
     *      6a. If `pendingTeardownCandidate === null` AND the candidate does
     *          NOT cross the teardown threshold: commit `_model = candidate`
     *          and serve the cumulative deltas. (The normal path — the
     *          overwhelming majority of cycles.)
     *      6b. If `pendingTeardownCandidate === null` AND the candidate DOES
     *          cross the threshold: stash it as `pendingTeardownCandidate`
     *          and loop into one more cycle. The guard's confirming cycle.
     *          Counts against the budget — see the module's "Budget
     *          interaction" section for the design call.
     *      6c. If `pendingTeardownCandidate !== null` (this IS the
     *          confirming cycle): compare the new candidate against
     *          `startModel`. If it ALSO crosses the threshold → confirmed:
     *          commit this NEW candidate, bump the confirmed counter, serve
     *          the cumulative deltas. (We commit the fresh one, not the
     *          stashed one, because tmux may have moved slightly between
     *          them — the second snapshot is the more current truth.) If it
     *          does NOT cross → refuted: discard both candidates, log
     *          loudly, bump the refuted counter, re-arm dirty, return
     *          `failed: true`.
     *   7. If the budget is exhausted without a clean commit-or-refute
     *      decision: treat as failed (same shape as step 3). The
     *      coalescer's failed-path schedules a retry at the next ceiling
     *      boundary, and the heartbeat guarantees eventual convergence.
     *      Importantly, NO cycle of this call has observably committed:
     *      `_model` is still `startModel`, so future diffs are computed
     *      against the same baseline the caller knows. The teardown
     *      counters are NOT bumped in the budget-exhausted path — we never
     *      reached a confirm-vs-refute decision.
     *
     * The accumulated deltas are `diffModel(startModel, _model)`, NOT the
     * concatenation of per-cycle deltas — concatenating would emit
     * pane.opened + pane.closed pairs for any pane that flickered through an
     * intermediate cycle. The diff against the original `startModel` gives
     * the minimal observable wire change, which is what clients want.
     */
    async _runCycles(startModel) {
        // tc-3si.2: the first candidate that tripped the guard, held back so we
        // can run one confirming cycle. `null` means "no teardown is being
        // confirmed right now" — either we haven't seen a teardown candidate or
        // the previous cycle was dirty and we discarded what we had.
        let pendingTeardownCandidate = null;
        let pendingTeardownFractions = null;
        for (let attempt = 0; attempt < CYCLE_BUDGET; attempt++) {
            this._dirty = false;
            const [winCmd, paneCmd] = bootstrapCommands(this._sessionTarget());
            // Issue both commands before awaiting either, mirroring the bootstrap
            // coordinator's FIFO pairing. The correlator the caller wired up
            // matches replies in send order, so the first promise is the windows
            // reply and the second is the panes reply.
            const winPromise = this._submit(winCmd);
            const panePromise = this._submit(paneCmd);
            const [winResult, paneResult] = await Promise.all([winPromise, panePromise]);
            // Steady-state failure policy: if either list-* reply is %error, do
            // NOT clobber the model — re-arm the dirty bit so the coalescer's
            // next edge or heartbeat retries. The candidate (if any) is
            // discarded; _model is still startModel because we never wrote to it.
            // The pending teardown candidate (if any) is also discarded — we
            // can't confirm against a %error.
            //
            // tc-0v59: the failure is now VISIBLE per incident. The legitimate
            // transient-retry behaviour is unchanged (a single blip during a
            // notification storm still re-arms dirty and retries); the ONLY change
            // is the loud per-incident stderr line below, in line with the
            // budget-exhausted and refuted-teardown siblings. A persistent requery
            // %error (e.g. a stale-target regression) can no longer spin invisibly.
            if (!winResult.ok || !paneResult.ok) {
                this._dirty = true;
                this._reportRequeryError(winResult, paneResult);
                this._reportCycleFailed("error");
                return { next: startModel, deltas: [], failed: true };
            }
            // Parse into a CANDIDATE model held in a local. Crucially, do NOT
            // write `this._model` yet — that's the commit-only-clean invariant.
            // If a mid-flight notification dirtied us, this candidate is
            // possibly-stale and must be discarded.
            const windowRows = parseWindowsReply(winResult.body);
            const paneRows = parsePanesReply(paneResult.body);
            // tc-4b6k.2: carry per-client binding intent forward — the bulk requery
            // does not read the per-client `@tmuxcc-bound-<key>` options, so a fresh
            // candidate pane's boundClients is empty; adopt the pre-call model's set
            // for surviving panes so a topology-only cycle never clobbers binding.
            const candidate = carryForwardBoundClients(startModel, buildInitialModel(windowRows, paneRows));
            // tc-0v59: capture the IMMUTABLE session id from the first successful
            // reply, then target by `$<id>` on every subsequent cycle. The id is in
            // the BOOTSTRAP_*_FORMAT replies (field [0] of each window/pane row).
            // Capturing it here — after a clean parse, regardless of the dirty bit —
            // means we lock onto the id the moment we first see the session, so a
            // later rename never points the requery at a stale name. We never
            // OVERWRITE a captured id (it is immutable), so a transient cross-session
            // contamination cannot hijack the binding once it is set.
            this._captureSessionId(windowRows, paneRows);
            if (this._dirty) {
                // Dirty mid-flight: discard candidate AND any pending teardown
                // confirmation in progress (we can't carry a stale comparison
                // baseline across notifications), then loop. Subject to budget.
                pendingTeardownCandidate = null;
                pendingTeardownFractions = null;
                continue;
            }
            // Clean cycle. Decide via the teardown-confirmation guard (tc-3si.2):
            const fractions = teardownFractions(startModel, candidate);
            const tripped = wouldTeardown(fractions, this._teardownThreshold);
            if (pendingTeardownCandidate === null) {
                if (!tripped) {
                    // Normal path: commit the candidate and serve deltas against
                    // the pre-call model. The overwhelming majority of cycles
                    // land here. This is the ONLY non-confirmed write to _model.
                    this._model = candidate;
                    const deltas = diffModel(startModel, candidate);
                    return { next: candidate, deltas };
                }
                // Tripped: hold the candidate, loop for one confirming cycle.
                pendingTeardownCandidate = candidate;
                pendingTeardownFractions = fractions;
                continue;
            }
            // Confirming cycle: pendingTeardownCandidate is the first cycle's
            // teardown-shaped candidate. Compare the NEW candidate's teardown
            // fractions against the same threshold — if the new candidate also
            // tears down the model, the session-end is real (confirmed); if it
            // does not, the FIRST candidate was garbage (refuted).
            const firstFractions = pendingTeardownFractions;
            pendingTeardownCandidate = null;
            pendingTeardownFractions = null;
            const info = {
                outcome: tripped ? "confirmed" : "refuted",
                // Report the FIRST candidate's fractions — that's the snapshot
                // whose teardown shape we held back from clients, the one whose
                // legitimacy we just adjudicated. Reporting the confirming
                // cycle's fractions would hide the question we were asking.
                closedPanesFraction: firstFractions.panes,
                closedWindowsFraction: firstFractions.windows,
                threshold: this._teardownThreshold,
                startPanes: startModel.panes.size,
                startWindows: startModel.windows.size,
            };
            this._reportTeardownOutcome(info);
            if (tripped) {
                // Confirmed: commit the SECOND candidate. We commit the fresh
                // snapshot (not the held-back one) because tmux may have moved
                // slightly between the two cycles — the confirming reply is the
                // more current truth. Both crossed the threshold so the wire
                // shape (mass close) is what the caller wanted either way.
                this._model = candidate;
                const deltas = diffModel(startModel, candidate);
                return { next: candidate, deltas };
            }
            // Refuted: discard both candidates, leave _model at startModel,
            // re-arm dirty so the coalescer's retry path picks the next
            // attempt up, return failed. The loud stderr log + counter bump
            // already happened inside _reportTeardownOutcome — by the time we
            // get here the bug class has been announced.
            //
            // tc-3si.5: a refuted teardown is NOT a generic cycle failure — the
            // dedicated `requery_teardown_confirmations_total{outcome="refuted"}`
            // counter already captures it with the correct semantic. Bumping
            // `requery_failed_cycles_total{reason=error|budget}` here would
            // muddle the failure-reason vocabulary (the failure here is neither
            // a tmux `%error` nor budget exhaustion). The refuted counter IS the
            // tripwire; the failed-cycles counter stays clean.
            this._dirty = true;
            return { next: startModel, deltas: [], failed: true };
        }
        // Budget exhausted: sustained notification storm dirtied every cycle,
        // OR a teardown candidate was tripped on the very last allowed cycle
        // and we never reached the confirming step. Bound the loop, re-arm
        // dirty so the coalescer retries at the next ceiling boundary, and
        // report failure. `_model` is unchanged from the pre-call snapshot
        // because no cycle ever committed. Teardown counters are NOT bumped:
        // we never adjudicated, only ran out of budget.
        //
        // tc-3si.5: bump the dedicated budget-exhausted counter AND the
        // failed-cycles counter with reason="budget" (they're on separate
        // surfaces so a session-proxy.info reader sees both totals at a
        // glance — see the registry module doc for the rationale). Loud-log
        // the exhaustion so the bug class survives metric-less test setups.
        this._dirty = true;
        this._reportBudgetExhausted();
        this._reportCycleFailed("budget");
        return { next: startModel, deltas: [], failed: true };
    }
    /**
     * Loud-log a requery `%error` cycle failure (tc-0v59).
     *
     * Mirrors `_reportBudgetExhausted` / `_reportTeardownOutcome`'s alert path:
     * one stderr line per incident, unconditional (independent of any wired
     * counter), not parsed by anything — a forensic trail. Names which reply
     * failed and the session target so a stale-target regression (the exact bug
     * this bead fixed) is instantly attributable instead of spinning silently
     * behind the coalescer's retry + heartbeat.
     *
     * NOTE: a SINGLE blip is expected during a notification storm and is
     * harmless (the cycle re-arms dirty and retries) — but per the pre-alpha
     * fail-loud policy the failure must still be VISIBLE per incident, not
     * swallowed into a silent counter.
     */
    _reportRequeryError(winResult, paneResult) {
        const which = !winResult.ok && !paneResult.ok
            ? "list-windows + list-panes"
            : !winResult.ok
                ? "list-windows"
                : "list-panes";
        const target = this._sessionTarget();
        const scope = target === undefined
            ? "-a (all sessions)"
            : target.kind === "id"
                ? `$${target.sessionId}`
                : `=${target.sessionName}`;
        process.stderr.write(`[requery-engine] REQUERY ERROR: tmux returned %error for ${which} ` +
            `(target ${scope}). The model is intact (kept the pre-cycle snapshot) and ` +
            `the cycle re-armed dirty for retry. A SINGLE blip during a notification ` +
            `storm is benign; a PERSISTENT %error means the target is wrong (e.g. a ` +
            `stale session name after a rename — tc-0v59) and the requery is stuck.\n`);
    }
    /**
     * Surface a cycle failure to the registry sink. Throws are caught and
     * swallowed — counter wiring must not break the pipeline.
     */
    _reportCycleFailed(reason) {
        if (this._onCycleFailed === undefined)
            return;
        try {
            this._onCycleFailed(reason);
        }
        catch {
            // Counter wiring must not break the pipeline.
        }
    }
    /**
     * Surface a budget exhaustion to the registry sink AND to stderr
     * (storm-alarm-style alert path). The loud log mirrors
     * `_reportTeardownOutcome`'s pattern: an expected-zero counter
     * incrementing is an alarm, not a silent counter — even without the
     * sink wired, the bug class lands one stderr line per incident.
     */
    _reportBudgetExhausted() {
        // Loud-log unconditionally (independent of whether onBudgetExhausted
        // is wired). One line per incident; not parsed by anything.
        process.stderr.write(`[requery-engine] BUDGET EXHAUSTED: ${CYCLE_BUDGET} convergence cycles ran without producing a clean commit. ` +
            `This is expected ONLY during a sustained tmux notification storm (the storm alarm should also be tripping). ` +
            `Exhaustion in isolation = a self-sourced rearm storm (mid-flight notification convergence pathology); ` +
            `coalescer will retry at the next ceiling boundary.\n`);
        if (this._onBudgetExhausted === undefined)
            return;
        try {
            this._onBudgetExhausted();
        }
        catch {
            // Counter wiring must not break the pipeline.
        }
    }
    /**
     * Surface a teardown-confirmation decision through the registry hook,
     * the optional subscriber, and (on `refuted`) a loud stderr log. The
     * stderr line mirrors `metrics/storm-alarm.ts`'s alert path: an
     * expected-zero counter incrementing is an alarm, not a silent counter,
     * so the bug class stays operationally visible even when the guard
     * absorbs the symptom.
     */
    _reportTeardownOutcome(info) {
        if (this._onTeardownOutcome !== undefined) {
            try {
                this._onTeardownOutcome(info.outcome);
            }
            catch {
                // Counter wiring must not break the pipeline. Mirrors the
                // coalescer's onNotify/onError convention.
            }
        }
        if (info.outcome === "refuted") {
            // Storm-alarm-style alert path: name the event, name the candidate's
            // shape, include the threshold so the operator can correlate against
            // the metric and the configuration. One line; not parsed by
            // anything — it's a forensic trail.
            const panesPct = (info.closedPanesFraction * 100).toFixed(1);
            const windowsPct = (info.closedWindowsFraction * 100).toFixed(1);
            const thresholdPct = (info.threshold * 100).toFixed(1);
            process.stderr.write(`[requery-engine] TEARDOWN REFUTED: a clean list-* cycle would have closed ${panesPct}% of panes ` +
                `and ${windowsPct}% of windows (threshold=${thresholdPct}%, start=${info.startPanes}p/${info.startWindows}w), ` +
                `but the confirming cycle disagreed — discarding the candidate and staying dirty. ` +
                `This is the tc-128.4 garbage-snapshot class surfacing through the tc-3si.2 guard; ` +
                `the model is intact and clients saw nothing, but a correlator slot/parser bug is upstream.\n`);
        }
        if (this._onTeardownConfirmation !== undefined) {
            try {
                this._onTeardownConfirmation(info);
            }
            catch {
                // Observer errors must not break the pipeline.
            }
        }
    }
}
/**
 * Default teardown threshold (tc-3si.2). 0.8 = 80% of the previous model's
 * panes or windows must be closed by a candidate for the confirmation
 * guard to fire. Picked per the bead description; tuneable per-engine via
 * `RequeryEngineOptions.teardownThreshold`.
 */
const DEFAULT_TEARDOWN_THRESHOLD = 0.8;
/**
 * Compute the fraction of `prev`'s panes/windows that are absent from
 * `candidate` — what the diff would close. Used by the teardown-
 * confirmation guard (tc-3si.2). Returns 0 for an empty `prev` (no
 * teardown possible — cold bootstrap is unaffected).
 *
 * Cheap: two set iterations sized by `prev`'s topology, no allocation
 * beyond the inputs. Called at most twice per `requery()` call (the
 * tripped first cycle and the confirming cycle).
 */
function teardownFractions(prev, candidate) {
    const prevPanes = prev.panes.size;
    const prevWindows = prev.windows.size;
    if (prevPanes === 0 && prevWindows === 0) {
        return { panes: 0, windows: 0 };
    }
    let closedPanes = 0;
    for (const id of prev.panes.keys()) {
        if (!candidate.panes.has(id))
            closedPanes++;
    }
    let closedWindows = 0;
    for (const id of prev.windows.keys()) {
        if (!candidate.windows.has(id))
            closedWindows++;
    }
    return {
        panes: prevPanes === 0 ? 0 : closedPanes / prevPanes,
        windows: prevWindows === 0 ? 0 : closedWindows / prevWindows,
    };
}
/**
 * The guard's trip predicate: a candidate "would tear down" if it closes
 * ≥ `threshold` of EITHER the previous panes OR the previous windows. The
 * canonical garbage-snapshot case (empty `list-windows` reply) closes
 * 100% of both, so it trips on either axis; using `max` (logical OR over
 * the two thresholds) means a partial-teardown garbage case (only one
 * `list-*` parse failed) still triggers the guard.
 */
function wouldTeardown(fractions, threshold) {
    return fractions.panes >= threshold || fractions.windows >= threshold;
}
/**
 * Maximum convergence cycles per `requery()` call (tc-128.5).
 *
 * Each cycle is ~0.5-1 ms (two pipelined `list-*` round-trips against tmux);
 * 5 comfortably covers the split-burst convergence case (one mid-flight
 * dirty, occasionally two) while bounding storm latency to ~5 ms before the
 * driver gives up and lets the coalescer's 1 Hz ceiling re-pace.
 *
 * Exported only via the module's internal contract; callers should not
 * depend on the exact value. A future change MAY tune this number based on
 * field observation, but the bound itself is structural.
 */
const CYCLE_BUDGET = 5;
//# sourceMappingURL=requery.js.map