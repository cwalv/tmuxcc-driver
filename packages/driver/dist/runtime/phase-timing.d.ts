/** True when TMUXCC_PHASE_TIMING is set to a non-empty value. Read once. */
export declare const PHASE_TIMING_ENABLED: boolean;
/**
 * A field value for a phase line. Numbers/booleans are emitted bare; strings
 * as-is. Keys with `undefined` values are omitted.
 */
export type PhaseFields = Record<string, string | number | boolean | undefined>;
/**
 * Emit one `[tc-is5w]` phase line to stderr. No-op when phase timing is
 * disabled. Never throws — instrumentation must not perturb the host (mirrors
 * tmux-host.ts wireTrace's swallow-everything contract).
 */
export declare function phaseLog(fields: PhaseFields): void;
/**
 * Wall-clock millisecond stamp for span measurement. A thin wrapper over
 * `Date.now()` (per the tc-is5w brief — spans, not high-resolution profiling)
 * so call sites read intent, not mechanism.
 */
export declare function phaseNow(): number;
//# sourceMappingURL=phase-timing.d.ts.map