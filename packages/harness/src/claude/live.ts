/**
 * Token streaming (U3 spec §11.1): what `--include-partial-messages` adds, never persisted and
 * never a `HarnessEvent`. `index` is the block's index in the API message (the reconcile key
 * with `messageId`); `line` is the stdout line it came from, for ordering against the persisted
 * events (§11.2).
 */
export type LiveEventBody =
  | { type: "text_start"; messageId: string; index: number }
  | { type: "text_delta"; messageId: string; index: number; text: string }
  | { type: "tool_start"; messageId: string; index: number; toolUseId: string; name: string }
  | { type: "tool_input"; messageId: string; index: number; bytes: number; target?: string }
  | { type: "thinking_start"; estimatedTokens?: number }
  | { type: "thinking_stop" }
  | {
      type: "subagent_progress";
      toolUseId: string;
      description: string;
      subagentType: string;
      toolUses: number;
      tokens: number;
      durationMs: number;
      lastTool?: string;
    }
  | { type: "message_stop"; messageId: string };

export type LiveEvent = LiveEventBody & { line: number };
