// tmuxcc-daemon — placeholder entry point.
// Real logic lives in parser/, state/, runtime/, wire/.

export const DAEMON_PLACEHOLDER = true;

/** Stub type: will be replaced by the real daemon interface. */
export interface DaemonHandle {
  readonly pid: number;
  stop(): Promise<void>;
}
