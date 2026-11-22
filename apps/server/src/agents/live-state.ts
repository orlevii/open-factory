import type { LiveEvent } from "@open-factory/harness";
import { type LiveFrame, liveKey, type SubagentProgress } from "@open-factory/shared";
import { CAP_BYTES, cut } from "./cap.ts";

/** A `live` frame without its envelope (U3 §11.3). */
export type LiveFrameBody = Omit<LiveFrame, "type" | "agent">;
type ToolInput = NonNullable<LiveFrame["toolInput"]>;

/** How often coalesced patches go out at most (U3 §11.2). */
export const LIVE_INTERVAL_MS = 50;

const enc = new TextEncoder();

interface Block {
  messageId: string;
  index: number;
  text: string;
  /** UTF-8 bytes of `text`, for the cap. */
  bytes: number;
  capped: boolean;
  startLine: number;
  /** How much of `text` (UTF-16 code units) the published frames already carry. */
  sent: number;
  cappedSent: boolean;
}

/**
 * The runtime's in-memory live state for one agent (U3 §11.2): the text blocks not yet retired, the tool input being
 * written, the open thinking and the running subagents. Never persisted. `apply` takes the live events of the current
 * process; retirement (a persisted row) and the ends (`turn_end`, `exited`) come from the serial job queue, which can
 * lag behind the live loop, so stdout line numbers order the two: an end clears only what started on an earlier line,
 * and a late event from before an end or for a retired key is dropped.
 */
export class LiveState {
  private texts: Block[] = [];
  private toolInput: (ToolInput & { key: string; startLine: number }) | undefined;
  private thinking: { tokens: number; startLine: number } | undefined;
  private readonly subagents = new Map<string, SubagentProgress>();
  /** Keys retired by a persisted row in the open turn: their later deltas are dropped. */
  private readonly retiredKeys = new Set<string>();
  /** Subagents whose entry cleared: a late progress line must not bring one back. */
  private readonly finishedSubagents = new Set<string>();
  /** Events from lines before this are from a turn already ended. */
  private endedBefore = 0;
  private subagentsEndedBefore = 0;
  private toolDirty = false;
  private thinkingDirty = false;
  private subagentsDirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly publish: (body: LiveFrameBody) => void,
    private readonly intervalMs = LIVE_INTERVAL_MS,
  ) {}

  apply(e: LiveEvent): void {
    if (e.type === "subagent_progress") {
      if (e.line < this.subagentsEndedBefore || this.finishedSubagents.has(e.toolUseId)) return;
      const { type: _t, line: _l, ...p } = e;
      this.subagents.set(e.toolUseId, p);
      this.subagentsDirty = true;
      this.schedule(false);
      return;
    }
    if (e.line < this.endedBefore) return;
    switch (e.type) {
      case "text_start":
        if (!this.retiredKeys.has(liveKey(e.messageId, e.index))) this.block(e);
        return;
      case "text_delta": {
        if (this.retiredKeys.has(liveKey(e.messageId, e.index))) return;
        const b = this.block(e);
        if (b.capped) return;
        const first = b.text.length === 0;
        const bytes = enc.encode(e.text).length;
        if (b.bytes + bytes > CAP_BYTES) {
          b.text = cut(b.text + e.text);
          b.bytes = CAP_BYTES;
          b.capped = true;
        } else {
          b.text += e.text;
          b.bytes += bytes;
        }
        this.schedule(first);
        return;
      }
      case "tool_start": {
        const key = liveKey(e.messageId, e.index);
        if (this.retiredKeys.has(key)) return;
        this.toolInput = { toolUseId: e.toolUseId, name: e.name, bytes: 0, key, startLine: e.line };
        this.toolDirty = true;
        this.schedule(false);
        return;
      }
      case "tool_input": {
        const t = this.toolInput;
        if (!t || t.key !== liveKey(e.messageId, e.index)) return;
        t.bytes = e.bytes;
        if (e.target !== undefined) t.target = e.target;
        this.toolDirty = true;
        this.schedule(false);
        return;
      }
      case "thinking_start": {
        const tokens = e.estimatedTokens ?? this.thinking?.tokens ?? 0;
        if (this.thinking?.tokens === tokens) return;
        this.thinking = { tokens, startLine: this.thinking?.startLine ?? e.line };
        this.thinkingDirty = true;
        this.schedule(false);
        return;
      }
      case "thinking_stop":
        if (!this.thinking) return;
        this.thinking = undefined;
        this.thinkingDirty = true;
        this.schedule(false);
        return;
      default:
        return;
    }
  }

  /**
   * A persisted `assistant_text` or `tool_call` with this key reached the bus (U3 §11.2): its live block goes without a
   * frame (the client retires it on the same row), and later events for the key are dropped.
   */
  retire(key: string): void {
    this.retiredKeys.add(key);
    this.texts = this.texts.filter((b) => liveKey(b.messageId, b.index) !== key);
    if (this.toolInput?.key === key) {
      this.toolInput = undefined;
      this.toolDirty = false;
    }
  }

  /** A persisted `tool_call` without a key (an older row): clears the tool input if it is that call's. */
  retireTool(toolUseId: string): void {
    if (this.toolInput?.toolUseId !== toolUseId) return;
    this.toolInput = undefined;
    this.toolDirty = false;
  }

  /**
   * `turn_end` or `exited` at stdout line `line` (U3 §11.2): clears the text blocks, tool input and thinking that
   * started on an earlier line, and the retired keys; `exited` also clears the subagents. Publishes a `reset` when
   * anything was or still is live. An unknown line (a process without line numbers) clears everything.
   */
  endBefore(line: number, opts: { subagents: boolean }): void {
    const before = (startLine: number) => startLine < line;
    const retire = this.texts
      .filter((b) => before(b.startLine))
      .map((b) => liveKey(b.messageId, b.index));
    let changed = retire.length > 0;
    this.texts = this.texts.filter((b) => !before(b.startLine));
    if (this.toolInput && before(this.toolInput.startLine)) {
      this.toolInput = undefined;
      changed = true;
    }
    if (this.thinking && before(this.thinking.startLine)) {
      this.thinking = undefined;
      changed = true;
    }
    this.retiredKeys.clear();
    if (Number.isFinite(line)) this.endedBefore = Math.max(this.endedBefore, line);
    if (opts.subagents) {
      if (this.subagents.size > 0) changed = true;
      this.subagents.clear();
      this.finishedSubagents.clear();
      if (Number.isFinite(line))
        this.subagentsEndedBefore = Math.max(this.subagentsEndedBefore, line);
    }
    if (!changed && this.isEmpty()) return;
    this.publishReset(retire);
  }

  /** A subagent finished (its `background_task_finished`, or a non-async call's `tool_result`): its entry goes. */
  finishSubagent(toolUseId: string): void {
    this.finishedSubagents.add(toolUseId);
    if (!this.subagents.delete(toolUseId)) return;
    this.publishReset([]);
  }

  /**
   * A new process: line numbers start again. Its predecessor's `exited` normally cleared the state already; a start
   * inside that exit's handling (a crash restart) clears it here, with a `reset` when anything was live.
   */
  newProcess(): void {
    this.endBefore(Number.POSITIVE_INFINITY, { subagents: true });
    this.endedBefore = 0;
    this.subagentsEndedBefore = 0;
  }

  /** The whole state as a `reset` body (U3 §11.3): a subscriber's catch-up and the answer to `live_snapshot`. */
  snapshot(): LiveFrameBody {
    return {
      reset: true,
      texts: this.texts.map((b) => ({
        messageId: b.messageId,
        index: b.index,
        offset: 0,
        append: b.text,
        ...(b.capped ? { capped: true } : {}),
      })),
      toolInput: this.toolInput ? this.publicTool(this.toolInput) : null,
      thinking: this.thinking ? { tokens: this.thinking.tokens } : null,
      subagents: [...this.subagents.values()],
    };
  }

  /** What changed since the last published frame, as a patch; undefined when nothing did. */
  drainPatch(): LiveFrameBody | undefined {
    const body: LiveFrameBody = {};
    const texts: NonNullable<LiveFrameBody["texts"]> = [];
    for (const b of this.texts) {
      const capNews = b.capped && !b.cappedSent;
      if (b.text.length === b.sent && !capNews) continue;
      texts.push({
        messageId: b.messageId,
        index: b.index,
        offset: b.sent,
        append: b.text.slice(b.sent),
        ...(b.capped ? { capped: true } : {}),
      });
      b.sent = b.text.length;
      b.cappedSent = b.capped;
    }
    if (texts.length) body.texts = texts;
    if (this.toolDirty) body.toolInput = this.toolInput ? this.publicTool(this.toolInput) : null;
    if (this.thinkingDirty) body.thinking = this.thinking ? { tokens: this.thinking.tokens } : null;
    if (this.subagentsDirty) body.subagents = [...this.subagents.values()];
    this.toolDirty = this.thinkingDirty = this.subagentsDirty = false;
    return Object.keys(body).length ? body : undefined;
  }

  /** Stops the coalescing timer (the runtime is going away). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private block(e: { messageId: string; index: number; line: number }): Block {
    const found = this.texts.find((b) => b.messageId === e.messageId && b.index === e.index);
    if (found) return found;
    const b: Block = {
      messageId: e.messageId,
      index: e.index,
      text: "",
      bytes: 0,
      capped: false,
      startLine: e.line,
      sent: 0,
      cappedSent: false,
    };
    this.texts.push(b);
    return b;
  }

  private publicTool(t: ToolInput & { key: string; startLine: number }): ToolInput {
    return {
      toolUseId: t.toolUseId,
      name: t.name,
      bytes: t.bytes,
      ...(t.target !== undefined ? { target: t.target } : {}),
    };
  }

  private isEmpty(): boolean {
    return !this.texts.length && !this.toolInput && !this.thinking && !this.subagents.size;
  }

  private publishReset(retire: string[]): void {
    const body = this.snapshot();
    for (const b of this.texts) {
      b.sent = b.text.length;
      b.cappedSent = b.capped;
    }
    this.toolDirty = this.thinkingDirty = this.subagentsDirty = false;
    this.publish(retire.length ? { ...body, retire } : body);
  }

  /** Leading edge for a block's first delta when the window is free; otherwise at most one patch per window. */
  private schedule(leading: boolean): void {
    if (this.timer) return;
    if (leading) this.flush();
    this.arm();
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.flush()) this.arm(); // keep the window while frames are flowing
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private flush(): boolean {
    const patch = this.drainPatch();
    if (patch) this.publish(patch);
    return patch !== undefined;
  }
}
