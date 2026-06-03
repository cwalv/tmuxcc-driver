/**
 * Client→tmux input path (tc-kvk).
 *
 * Maps `ClientMessage` wire messages to tmux control-mode commands and writes
 * them to the tmux host's stdin.  This is the CLIENT→TMUX direction; the
 * complementary TMUX→CLIENT direction (output demux) is handled by tc-fbz.
 *
 * # Handled message types
 *
 *   - `input`          → `send-keys -H -t %<N> <hex-bytes…>`
 *   - `resize.request` → `refresh-client -C <cols>x<rows>`
 *   - `command.request`→ mapped to the matching tmux command via the E2
 *                        serializers (split-pane, new-window etc.).
 *   - `client.capabilities` — silently ignored (handshake concern, tc-auj).
 *
 * # Id-mapping approach
 *
 * Wire `PaneId` / `WindowId` values follow the daemon's minting convention
 * (confirmed in src/state/reducer.ts):
 *
 *   - PaneId   → `"p" + tmuxPaneNum`   (e.g. "p1" → tmux pane %1)
 *   - WindowId → `"w" + tmuxWindowNum` (e.g. "w3" → tmux window @3)
 *
 * These are invertible by stripping the leading letter and parsing the
 * remainder as a decimal integer.  The helpers `paneIdToTmux` and
 * `windowIdToTmux` perform this inversion.
 *
 * LIMITATION: this approach relies on the "p<N>"/"w<N>" prefix convention
 * being stable.  A future registry-based approach (daemon-level Map<PaneId,
 * number>) would be more robust if the convention changes — e.g. to support
 * multi-session namespacing like "s0-p3".  The factory accepts an optional
 * `paneIdToTmux` override so callers can inject a registry at integration
 * time without changing this module.
 *
 * # Resize mapping decision
 *
 * `ResizeRequestMessage{paneId, cols, rows}` represents a client viewport
 * change — the host window (VS Code pane, terminal emulator) was resized.
 * The correct tmux command is `refresh-client -C <cols>x<rows>`, which sets
 * the **control-mode client** terminal size.  tmux then propagates the new
 * client size to the window layout and ultimately to individual panes.
 *
 * Per-pane sizing via `refresh-client -C @<win>:<cols>x<rows>` (tmux ≥ 3.4)
 * would be the right primitive for multi-window per-tab sizing (e.g. iTerm2),
 * but requires knowing which window the pane belongs to and is outside the
 * scope of this bead.  The `ResizePaneCommand` wire command (handled below) is
 * the explicit user-initiated resize path and also maps to `refresh-client -C`
 * for now; a future bead can refine this to `resize-pane` if needed.
 *
 * # API seam
 *
 * The daemon's serve layer (tc-dv3) constructs an InputPath and forwards each
 * decoded ClientMessage to `handleClientMessage`.  Example wiring:
 *
 * ```ts
 * const path = createInputPath(host);
 * transport.onControl(msg => path.handleClientMessage(msg));
 * ```
 */

import type { TmuxHost } from "./tmux-host.js";
import type { ClientMessage } from "../wire/index.js";
import type { PaneId, WindowId, SessionId } from "../wire/index.js";
import {
  sendKeysHex,
  refreshClientSize,
  refreshClientWindowSize,
  splitWindow,
  newWindow,
} from "../parser/commands.js";

// ---------------------------------------------------------------------------
// Id-mapping helpers
// ---------------------------------------------------------------------------

/**
 * Default PaneId→tmux-numeric inversion.
 *
 * Strips the leading "p" prefix and parses the remainder as a decimal integer.
 * Returns NaN if the id does not match the expected format; callers should
 * guard against NaN before issuing commands.
 *
 * Convention source: src/state/reducer.ts `mintPaneId("p" + tmuxId)`.
 */
function defaultPaneIdToTmux(id: PaneId): number {
  const s = id as string;
  if (!s.startsWith("p")) return NaN;
  const n = parseInt(s.slice(1), 10);
  return n;
}

/**
 * Default WindowId→tmux-numeric inversion.
 *
 * Strips the leading "w" prefix and parses the remainder as a decimal integer.
 *
 * Convention source: src/state/reducer.ts `mintWindowId("w" + tmuxId)`.
 */
function defaultWindowIdToTmux(id: WindowId): number {
  const s = id as string;
  if (!s.startsWith("w")) return NaN;
  return parseInt(s.slice(1), 10);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Default SessionId→tmux-name inversion.
 *
 * Strips the leading "s" prefix to recover the raw session name used at
 * startup.  If the id does not start with "s" the raw string is used as-is
 * (forward-compatible for non-prefixed session ids).
 *
 * Convention source: src/state/reducer.ts `mintSessionId("s" + name)`.
 */
function defaultSessionIdToTmux(id: SessionId): string {
  const s = id as string;
  return s.startsWith("s") ? s.slice(1) : s;
}

/** Options for createInputPath. */
export interface InputPathOptions {
  /**
   * Override the default PaneId→tmux-numeric mapping.
   *
   * The default strips the "p" prefix and parses the trailing decimal integer.
   * Supply a registry-backed function here when the daemon maintains an
   * explicit PaneId↔tmux-number map (more robust for future multi-session
   * namespacing).
   */
  paneIdToTmux?: (id: PaneId) => number;

  /**
   * Override the default WindowId→tmux-numeric mapping.
   *
   * The default strips the "w" prefix and parses the trailing decimal integer.
   */
  windowIdToTmux?: (id: WindowId) => number;

  /**
   * Override the default SessionId→tmux-name mapping.
   *
   * The default strips the leading "s" prefix to recover the raw session name.
   * Supply an override when the daemon maintains an explicit SessionId→name map.
   */
  sessionIdToTmux?: (id: SessionId) => string;
}

/** The input path handle returned by createInputPath. */
export interface InputPath {
  /**
   * Route a ClientMessage to the appropriate tmux command and write it to the
   * host's stdin.  Unrecognised or handshake-only messages are silently ignored.
   *
   * Guaranteed not to throw for well-formed messages with valid ids.  If an id
   * does not parse (NaN), the message is dropped and a warning is logged.
   */
  handleClientMessage(msg: ClientMessage): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an InputPath that routes ClientMessages to tmux commands.
 *
 * @param host  The TmuxHost to write commands to (must have been started by
 *              the caller before messages are routed here).
 * @param opts  Optional id-mapping overrides and future extension points.
 * @returns     An InputPath whose `handleClientMessage` method the serve layer
 *              (tc-dv3) should call for each decoded ClientMessage.
 *
 * @example
 * ```ts
 * const host = createTmuxHost({ socketName: "myapp" });
 * await host.start();
 * const inputPath = createInputPath(host);
 * transport.onControl(msg => inputPath.handleClientMessage(msg));
 * ```
 */
export function createInputPath(
  host: TmuxHost,
  opts: InputPathOptions = {},
): InputPath {
  const toTmuxPane = opts.paneIdToTmux ?? defaultPaneIdToTmux;
  const toTmuxWindow = opts.windowIdToTmux ?? defaultWindowIdToTmux;
  const toTmuxSession = opts.sessionIdToTmux ?? defaultSessionIdToTmux;

  /** Write a tmux command line (appends \n). */
  function sendCommand(cmd: string): void {
    host.write(cmd + "\n");
  }

  /** Guard: log and return false if tmuxId is NaN. */
  function validPaneId(tmuxId: number, wireId: string): boolean {
    if (Number.isNaN(tmuxId)) {
      console.warn(`[input-path] cannot map pane id "${wireId}" to tmux numeric id — dropping message`);
      return false;
    }
    return true;
  }

  function validWindowId(tmuxId: number, wireId: string): boolean {
    if (Number.isNaN(tmuxId)) {
      console.warn(`[input-path] cannot map window id "${wireId}" to tmux numeric id — dropping message`);
      return false;
    }
    return true;
  }

  function handleClientMessage(msg: ClientMessage): void {
    switch (msg.type) {
      // -----------------------------------------------------------------------
      // input → send-keys -H
      //
      // The data field is a UTF-8 string.  UTF-8-encode it to bytes and pass
      // through sendKeysHex, which hex-encodes each byte.  This is the lossless
      // path: all byte values including NUL, 0xFF, and C0 control sequences are
      // preserved exactly.  The client pre-encodes special keys as their byte
      // sequences (e.g. ESC-[ sequences for arrow keys) so we just encode the
      // string verbatim.
      // -----------------------------------------------------------------------
      case "input": {
        const tmuxPaneNum = toTmuxPane(msg.paneId);
        if (!validPaneId(tmuxPaneNum, msg.paneId as string)) return;

        const bytes = new TextEncoder().encode(msg.data);
        const cmd = sendKeysHex(tmuxPaneNum, bytes);
        sendCommand(cmd);
        break;
      }

      // -----------------------------------------------------------------------
      // resize.request → refresh-client -C <cols>x<rows>
      //
      // Signals that the client viewport (VS Code pane, terminal window) changed
      // size.  `refresh-client -C WxH` updates the control-mode client's
      // reported terminal dimensions.  tmux propagates this to the window layout
      // and, through layout recalculation, to individual pane sizes.
      //
      // The paneId is carried in the message but is not used in the tmux command:
      // `refresh-client -C` operates on the client (not a specific pane), and
      // tmux determines which pane(s) to resize through its layout engine.  This
      // is the correct mapping for a viewport-driven resize; a per-pane explicit
      // resize would use `resize-pane` (see ResizePaneCommand below).
      // -----------------------------------------------------------------------
      case "resize.request": {
        const cmd = refreshClientSize(msg.cols, msg.rows);
        sendCommand(cmd);
        break;
      }

      // -----------------------------------------------------------------------
      // command.request → tmux command via E2 serializers
      //
      // The WireCommand union covers model-level operations.  We handle the ones
      // for which a direct serializer exists.  Each branch maps kind → tmux cmd.
      // -----------------------------------------------------------------------
      case "command.request": {
        const { command } = msg;
        switch (command.kind) {
          case "open-window": {
            // new-window with optional name.
            const cmd = newWindow(
              command.name !== undefined ? { name: command.name } : undefined,
            );
            sendCommand(cmd);
            break;
          }

          case "split-pane": {
            const tmuxPaneNum = toTmuxPane(command.paneId);
            if (!validPaneId(tmuxPaneNum, command.paneId as string)) return;

            // direction: "horizontal" = left/right (-h); "vertical" = top/bottom (-v)
            const cmd = splitWindow(tmuxPaneNum, command.direction);
            sendCommand(cmd);
            break;
          }

          case "close-pane": {
            // kill-pane -t %<N>
            const tmuxPaneNum = toTmuxPane(command.paneId);
            if (!validPaneId(tmuxPaneNum, command.paneId as string)) return;

            sendCommand(`kill-pane -t %${tmuxPaneNum}`);
            break;
          }

          case "rename-window": {
            // rename-window -t @<N> <name>
            const tmuxWinNum = toTmuxWindow(command.windowId);
            if (!validWindowId(tmuxWinNum, command.windowId as string)) return;

            // Single-quote the name to handle spaces / special chars.
            const quotedName = "'" + command.name.replace(/'/g, "'\\''") + "'";
            sendCommand(`rename-window -t @${tmuxWinNum} ${quotedName}`);
            break;
          }

          case "select-pane": {
            // select-pane -t %<N>
            const tmuxPaneNum = toTmuxPane(command.paneId);
            if (!validPaneId(tmuxPaneNum, command.paneId as string)) return;

            sendCommand(`select-pane -t %${tmuxPaneNum}`);
            break;
          }

          case "resize-pane": {
            // The wire ResizePaneCommand is an explicit user-initiated resize
            // (distinct from viewport-driven resize.request).  We map it to
            // refresh-client -C as the simplest correct tmux command for now.
            // A future refinement could use `resize-pane -t %<N> -x <cols> -y <rows>`
            // for per-pane control, which requires tmux layout awareness.
            const cmd = refreshClientSize(command.cols, command.rows);
            sendCommand(cmd);
            break;
          }

          case "kill-session": {
            // kill-session -t <name>
            // Terminates the tmux session and all its windows/panes.
            // Used when tmuxcc.killSessionOnLastWindowClose=true (ux-design.md §13).
            // The daemon will receive a session exit notification from tmux;
            // callers should expect the connection to close shortly after.
            const sessionName = toTmuxSession(command.sessionId);
            sendCommand(`kill-session -t ${sessionName}`);
            break;
          }

          default: {
            // Forward-compatible: unknown command kinds are silently dropped.
            const _exhaustive = command as { kind: string };
            console.warn(`[input-path] unknown command kind "${_exhaustive.kind}" — dropping`);
            break;
          }
        }
        break;
      }

      // -----------------------------------------------------------------------
      // client.capabilities — handshake message, not an input/command.
      // Silently ignored here; the handshake layer (tc-auj) handles it.
      // -----------------------------------------------------------------------
      case "client.capabilities":
        break;

      default: {
        // Forward-compatible: unknown message types are silently ignored.
        const _exhaustive = msg as { type: string };
        console.warn(`[input-path] unknown message type "${_exhaustive.type}" — dropping`);
        break;
      }
    }
  }

  return { handleClientMessage };
}

// ---------------------------------------------------------------------------
// Exports — id-mapping helpers exposed for tests and potential registry wiring
// ---------------------------------------------------------------------------

export { defaultPaneIdToTmux, defaultWindowIdToTmux, defaultSessionIdToTmux };
