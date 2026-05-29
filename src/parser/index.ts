/**
 * tmux -CC control-mode stream parser.
 *
 * The parser module is the SOUTH-facing layer of the daemon: it consumes the
 * raw byte stream from `tmux -CC` and emits typed tokens for higher-level
 * consumers.
 *
 * Public surface:
 *   - `ControlTokenizer`  — stateful streaming tokenizer (tc-ckw)
 *   - `tokenizeBuffer`    — convenience one-shot tokenize helper (tc-ckw)
 *   - `ControlToken` and all token variant types (tc-ckw)
 *
 * Sibling beads that extend this surface:
 *   - tc-8yz: %output octal byte codec (consumes NotificationToken.rawLine)
 *   - tc-82a: %begin/%end/%error correlation into request/response pairs
 *   - tc-wvu: notification semantic parsing (consumes NotificationToken)
 *   - tc-efj: layout-string parser
 */

export {
  ControlTokenizer,
  tokenizeBuffer,
} from "./tokenizer.js";

export type {
  ControlToken,
  NotificationToken,
  BlockBeginToken,
  BlockBodyToken,
  BlockEndToken,
  BlockErrorToken,
  DcsOpenToken,
  DcsCloseToken,
} from "./tokenizer.js";
