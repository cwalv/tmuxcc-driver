/**
 * Control-plane wire schema tests.
 *
 * These tests verify:
 *   1. Representative control messages can be constructed with correct shapes.
 *   2. Type guards (isControlMessage, isSessionProxyMessage, isClientMessage) narrow
 *      correctly at runtime.
 *   3. The discriminated union covers all expected message types.
 *
 * Full encode/decode round-trip across a transport is tc-fwb's job. The tests
 * here focus on structural correctness and type-guard behaviour.
 */
export {};
//# sourceMappingURL=wire.test.d.ts.map