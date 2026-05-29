/**
 * @tmuxcc/client — headless client for tmuxcc.
 *
 * No DOM, no host API, no tmux vocabulary.
 * Safe to import in Node, bundled for the browser, or run in a worker.
 */

/** Placeholder export — replaced as domain modules land in later epics. */
export const CLIENT_PLACEHOLDER = true;

/**
 * Stub type that will eventually describe a connected client session.
 * Declared here so dependents can import the type before the real impl lands.
 */
export interface ClientSession {
  readonly id: string;
}
