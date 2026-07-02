/** True when the instrument is enabled (any non-empty value). Read once. */
export declare const DEATH_INSTRUMENT_ENABLED: boolean;
/** Which host event drove the death. */
export type DeathPath = "onExit" | "onError";
export interface HostDeathRecord {
    /** Which handler fired — the (a)-vs-(c) discriminator. */
    path: DeathPath;
    /** onExit: process exit code (may be null). */
    code?: number | null;
    /** onExit: terminating signal name (may be null). */
    signal?: string | null;
    /** onError: the fault routed out of node-pty (the tc-crnt.14 pty read fault). */
    error?: Error;
    /** Session identity for correlation with the failing spec. */
    sessionId: string;
    sessionName: string;
    /** tmux -L socket name, for the optional server-liveness probe. */
    socketName: string;
    /**
     * `entry.tornDown` AS OBSERVED at the death instant — the mid-flood (false)
     * vs orderly-teardown (true) discriminator.
     */
    tornDown: boolean;
}
/**
 * Record a host death.  No-op when the instrument is disabled.  Never throws —
 * instrumentation must not perturb the host (mirrors phaseLog / wireTrace).
 *
 * Emits ONE `[tc-jlyi.17] hostDeath ...` line with the discriminator path,
 * tornDown (mid-flood vs teardown), host memory at the instant, and the
 * tmux-server liveness/RSS probe; plus, for onError, a second
 * `[tc-jlyi.17] hostDeath-errstack ...` line carrying the fault stack (the
 * tc-crnt.14 pty read-socket-fault signature).
 */
export declare function recordHostDeath(rec: HostDeathRecord): void;
//# sourceMappingURL=death-instrument.d.ts.map