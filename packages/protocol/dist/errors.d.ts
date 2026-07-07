/**
 * Typed command-failure envelope — tc-u4ny.1.
 *
 * `CommandFailure` is the shared wire failure branch for BOTH result unions:
 *   - ServerProxyCommandResponseMessage (server-proxy-control.ts)
 *   - SessionProxyCommandResponseMessage (session-proxy-control.ts)
 *
 * `CommandError` is the thrown-Error sibling of `CommandFailure`, structured
 * as a HandshakeError peer (handshake.ts:122-130) so driver internals can
 * propagate command failures through async catch chains without losing the
 * code and structured details.
 *
 * `isCommandError` discriminates STRUCTURALLY (name + code check, not
 * instanceof) to survive the dual-package-copy hazard: a VS Code extension
 * host may load two copies of the protocol bundle (the extension bundle and a
 * local dev checkout), causing instanceof to return false for a genuine
 * CommandError from the other copy.
 *
 * # Details contracts
 *
 * `CapabilityRequiredDetails` is the SOLE defined details contract in this
 * bead. Do NOT add further details shapes here — that is tc-u4ny.2's scope.
 *
 * # Wire safety
 *
 * `details` arrives via bare JSON.parse. It is NOT schema-validated on
 * receipt. Use `requiredCapability()` (or a future equivalent) to safely
 * narrow before acting; never cast directly from `err.details`.
 */
import type { TmuxCapabilityMap } from "./server-proxy-control.js";
/**
 * The shared wire failure branch used by BOTH result unions on both wires.
 *
 * Adding `details` to this shared type puts the optional structured-context
 * slot on BOTH wires' failure branches without touching each wire's message
 * definition separately. The driver bead (tc-u4ny.2) threads details from
 * existing throw sites through this envelope.
 *
 * `details` is optional and absent for all codes that define no contract.
 * The only defined contract today: code `"tmux.capability-required"` carries
 * {@link CapabilityRequiredDetails}. All other codes carry no details.
 */
export interface CommandFailure {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
    /**
     * Structured detail payload.  Present only when the failure code defines a
     * contract.  The sole contract today: code `"tmux.capability-required"`
     * carries `{ capability: keyof TmuxCapabilityMap }`.  Absent for all other
     * failure codes.
     *
     * WIRE SOURCED: details arrive via bare JSON.parse and are NOT
     * schema-validated on receipt.  Use `requiredCapability()` to safely narrow
     * the value rather than casting directly.
     */
    readonly details?: unknown;
}
/**
 * Structured detail payload for code `"tmux.capability-required"`.
 *
 * Carried when a command failed because the connected tmux binary is too old
 * to support the requested feature.  The `capability` key names the entry in
 * `TmuxCapabilityMap` that was probed and found false.
 *
 * This is the ONLY defined details contract in this bead (tc-u4ny.1).
 * Do not add further details shapes here — that is tc-u4ny.2's scope.
 */
export interface CapabilityRequiredDetails {
    /** The `TmuxCapabilityMap` key identifying the missing capability. */
    readonly capability: keyof TmuxCapabilityMap;
}
/**
 * Thrown (or returned as a rejection) when a wire command fails.
 *
 * Structural sibling of `HandshakeError` (handshake.ts:122-130).  Driver
 * internals throw or re-throw `CommandError` so that async catch chains see a
 * typed failure rather than a plain `Error` or a bare `{ code, message }`
 * object.
 *
 * # Discrimination
 *
 * Use {@link isCommandError} rather than `instanceof CommandError`.  The
 * dual-package-copy hazard (two copies of the protocol bundle in the same
 * extension-host process) means `instanceof` can return `false` for a genuine
 * `CommandError` from the other copy.  `isCommandError` checks `name` and
 * `code` structurally and survives the hazard.
 */
export declare class CommandError extends Error {
    readonly code: string;
    readonly details: unknown;
    constructor(code: string, message: string, details?: unknown);
}
/**
 * Structural discriminator for `CommandError`.
 *
 * Checks `name === "CommandError"` and `typeof code === "string"`
 * structurally to survive the dual-package-copy hazard — two copies of the
 * protocol bundle in the same VS Code extension-host process cause
 * `instanceof` to return `false` for a genuine `CommandError` from the other
 * copy.
 *
 * When `code` is provided, also narrows to that specific error code.
 *
 * @example
 * ```ts
 * if (isCommandError(err, "tmux.capability-required")) {
 *   const d = requiredCapability(err as CommandError);
 * }
 * ```
 */
export declare function isCommandError(err: unknown, code?: string): err is CommandError;
/**
 * Extract {@link CapabilityRequiredDetails} from a `CommandError`'s `details` field.
 *
 * Returns the details narrowed as `CapabilityRequiredDetails` when the value
 * passes a minimal structural check (`capability` is a string).  Returns
 * `undefined` when absent or malformed.
 *
 * # Trusting-cast note
 *
 * `details` arrives from bare JSON.parse on the wire and has NOT been
 * schema-validated.  This function verifies only that `capability` is a
 * string — it CANNOT guarantee that the value is a valid `keyof
 * TmuxCapabilityMap`.  Callers must treat the result as a best-effort hint
 * and guard against unknown capability strings.
 */
export declare function requiredCapability(err: CommandError): CapabilityRequiredDetails | undefined;
/**
 * Convert a `CommandError` to a `CommandFailure` wire envelope.
 *
 * Strips the Error prototype chain; produces a plain JSON-serialisable
 * object.  `details` is forwarded when present.
 */
export declare function toCommandFailure(err: CommandError): CommandFailure;
//# sourceMappingURL=errors.d.ts.map