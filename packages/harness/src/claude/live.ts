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

/**
 * The reconcile key's index (U3 §11.1): a block's index in its API message is the content blocks
 * seen on earlier `assistant` lines with that id (including the thinking and empty-text blocks the
 * mapper drops) plus its position in this line. Cleared at `turn_end`, except for subagent
 * messages (lines with `parent_tool_use_id`): a background subagent's message can straddle the
 * main turn's end, so its count is kept until that subagent finishes (`forgetParent`).
 */
export class BlockIndexer {
  private readonly seen = new Map<string, number>();
  /** Subagent message ids, by the parent tool call that runs them. */
  private readonly parented = new Map<string, Set<string>>();

  indexFor(messageId: string, positionInLine: number): number {
    return (this.seen.get(messageId) ?? 0) + positionInLine;
  }

  seeLine(messageId: string, blocks: number, parentToolUseId?: string): void {
    this.seen.set(messageId, (this.seen.get(messageId) ?? 0) + blocks);
    if (parentToolUseId === undefined) return;
    const ids = this.parented.get(parentToolUseId) ?? new Set<string>();
    this.parented.set(parentToolUseId, ids);
    ids.add(messageId);
  }

  /** Turn end: forgets every main-session message; subagent messages keep their counts. */
  reset(): void {
    const keep = new Set<string>();
    for (const ids of this.parented.values()) for (const id of ids) keep.add(id);
    for (const id of this.seen.keys()) if (!keep.has(id)) this.seen.delete(id);
  }

  /** A subagent finished: its messages are complete, so their counts can go. */
  forgetParent(parentToolUseId: string): void {
    const ids = this.parented.get(parentToolUseId);
    if (!ids) return;
    for (const id of ids) this.seen.delete(id);
    this.parented.delete(parentToolUseId);
  }
}

/** Keys whose complete string value names a tool call's target (U3 §11.1). */
const TARGET_KEY = /"(?:file_path|command|pattern)"\s*:\s*"/g;
const enc = new TextEncoder();

/** A tool_use block's partial input, scanned incrementally for its target. */
interface ToolInputScan {
  json: string;
  bytes: number;
  target?: string;
  /** Where the next key search starts (a little before the previous end, for split keys). */
  keyFrom: number;
  /** Index just after the opening quote of the target's value, once its key is found. */
  valueAt?: number;
  /** How far the value has been scanned for its closing quote, and whether that char is escaped. */
  scanned: number;
  escaped: boolean;
}

export interface StreamState {
  /** The streamed message, from the last `message_start` (each stream line also names it). */
  messageId: string | undefined;
  /** Open thinking blocks of the streamed message, by index. */
  thinking: Set<number>;
  /** Open tool_use blocks of the streamed message, by index. */
  tools: Map<number, ToolInputScan>;
  /** The latest thinking estimate seen, carried by every `thinking_start`. */
  estimatedTokens: number | undefined;
}

export const createStreamState = (): StreamState => ({
  messageId: undefined,
  thinking: new Set(),
  tools: new Map(),
  estimatedTokens: undefined,
});

/** Advances the scan over newly appended JSON; sets `target` once its string value is complete. */
function scanTarget(t: ToolInputScan): void {
  if (t.target !== undefined) return;
  if (t.valueAt === undefined) {
    TARGET_KEY.lastIndex = t.keyFrom;
    const m = TARGET_KEY.exec(t.json);
    if (!m) {
      // A key split across chunks is found next time: search again from just before the end.
      t.keyFrom = Math.max(0, t.json.length - 24);
      return;
    }
    t.valueAt = m.index + m[0].length;
    t.scanned = t.valueAt;
  }
  for (let i = t.scanned; i < t.json.length; i++) {
    const c = t.json[i];
    if (t.escaped) t.escaped = false;
    else if (c === "\\") t.escaped = true;
    else if (c === '"') {
      try {
        const v = JSON.parse(t.json.slice(t.valueAt - 1, i + 1));
        if (typeof v === "string") t.target = v;
      } catch {
        // not a JSON string after all: no target
      }
      t.scanned = i + 1;
      return;
    }
  }
  t.scanned = t.json.length;
}

// biome-ignore lint/suspicious/noExplicitAny: stream-json lines are parsed JSON
type Json = Record<string, any>;

/** One `stream_event` line to live events (without `line`). Subagents never stream (spike). */
export function mapStreamEvent(line: Json, st: StreamState): LiveEventBody[] {
  if (line.parent_tool_use_id) return [];
  const ev: Json = line.event ?? {};
  if (ev.type === "message_start") {
    st.messageId = String(line.api_message_id ?? ev.message?.id ?? "");
    st.thinking.clear();
    st.tools.clear();
    return [];
  }
  const messageId = String(line.api_message_id ?? st.messageId ?? "");
  const index = Number(ev.index);
  switch (ev.type) {
    case "content_block_start": {
      const b: Json = ev.content_block ?? {};
      if (b.type === "text") return [{ type: "text_start", messageId, index }];
      if (b.type === "tool_use") {
        st.tools.set(index, { json: "", bytes: 0, keyFrom: 0, scanned: 0, escaped: false });
        return [
          { type: "tool_start", messageId, index, toolUseId: String(b.id), name: String(b.name) },
        ];
      }
      if (b.type === "thinking" || b.type === "redacted_thinking") {
        st.thinking.add(index);
        return [thinkingStart(st)];
      }
      return [];
    }
    case "content_block_delta": {
      const d: Json = ev.delta ?? {};
      if (d.type === "text_delta") {
        const text = String(d.text ?? "");
        return text ? [{ type: "text_delta", messageId, index, text }] : [];
      }
      if (d.type === "input_json_delta") {
        const t = st.tools.get(index);
        const chunk = String(d.partial_json ?? "");
        if (!t || !chunk) return [];
        // Once the target is known only the byte count matters: stop holding the input.
        if (t.target === undefined) t.json += chunk;
        t.bytes += enc.encode(chunk).length;
        scanTarget(t);
        if (t.target !== undefined) t.json = "";
        return [
          {
            type: "tool_input",
            messageId,
            index,
            bytes: t.bytes,
            ...(t.target !== undefined ? { target: t.target } : {}),
          },
        ];
      }
      if (d.type === "thinking_delta") {
        if (typeof d.estimated_tokens === "number") st.estimatedTokens = d.estimated_tokens;
        return [thinkingStart(st)];
      }
      return [];
    }
    case "content_block_stop":
      st.tools.delete(index);
      if (st.thinking.delete(index)) return [{ type: "thinking_stop" }];
      return [];
    case "message_stop":
      st.thinking.clear();
      st.tools.clear();
      st.estimatedTokens = undefined;
      return [{ type: "thinking_stop" }, { type: "message_stop", messageId }];
    default:
      return [];
  }
}

/** `system/thinking_tokens`: the running estimate of the open thinking. */
export function mapThinkingTokens(line: Json, st: StreamState): LiveEventBody[] {
  if (typeof line.estimated_tokens === "number") st.estimatedTokens = line.estimated_tokens;
  return [thinkingStart(st)];
}

const thinkingStart = (st: StreamState): LiveEventBody =>
  st.estimatedTokens === undefined
    ? { type: "thinking_start" }
    : { type: "thinking_start", estimatedTokens: st.estimatedTokens };

/** `system/task_progress`: a running subagent's counters. */
export function mapTaskProgress(line: Json): LiveEventBody[] {
  if (!line.tool_use_id) return [];
  const u: Json = line.usage ?? {};
  return [
    {
      type: "subagent_progress",
      toolUseId: String(line.tool_use_id),
      description: String(line.description ?? ""),
      subagentType: String(line.subagent_type ?? ""),
      toolUses: Number(u.tool_uses ?? 0),
      tokens: Number(u.total_tokens ?? 0),
      durationMs: Number(u.duration_ms ?? 0),
      ...(line.last_tool_name ? { lastTool: String(line.last_tool_name) } : {}),
    },
  ];
}
