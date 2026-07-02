/**
 * Protocol schema conformance tests — tc-1y2.
 *
 * Validates that representative wire messages (and the golden transcripts in
 * protocol/golden/) conform to the JSON Schemas in protocol/schemas/ using ajv.
 *
 * Purpose: schema drift fails this test suite. If a TS type changes in a way
 * that is no longer described by the protocol schemas, these tests fail in CI,
 * signalling that the schemas need to be updated.
 *
 * The test covers:
 *   1. Schema loading — all schema files parse and compile without errors.
 *   2. Session-proxy golden transcript — every message in
 *      protocol/golden/session-proxy-connect-snapshot.json validates.
 *   3. Server-proxy golden transcript — every message in
 *      protocol/golden/server-proxy-connect-snapshot.json validates.
 *   4. Representative negative cases — known-invalid messages are rejected.
 *   5. Representative TS-constructed messages — messages built from the TS
 *      types in wire/ are accepted by the schemas (cross-checks TS ↔ schema
 *      agreement).
 *
 * Import note: ajv is a devDependency hoisted to the tmuxcc-driver workspace
 * root (package.json at packages/session-proxy/../../../ level). It is NOT
 * bundled into the production package — conformance tests only run in CI.
 */
export {};
//# sourceMappingURL=protocol-conformance.test.d.ts.map