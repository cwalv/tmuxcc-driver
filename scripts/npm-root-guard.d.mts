// Type sidecar for the shared workspace-root npm guard (tc-rs99).
// The guard itself is plain ESM (.mjs) so npm can run it with bare `node`
// during preinstall/prebuild, before any build/tsx step exists. This declares
// the one pure export the unit tests pin.

export interface GuardContext {
  /** TMUXCC_NPM_FROM_ROOT === "1": a root-initiated flow already validated. */
  fromRoot: boolean;
  /** process.env.INIT_CWD — the dir npm was invoked from (may be undefined). */
  initCwd: string | undefined;
  /** process.cwd() — where the lifecycle script runs. */
  cwd: string;
}

/** True when this is a direct subdir invocation that must be blocked. */
export function isBlockedDirectSubdir(ctx: GuardContext): boolean;
