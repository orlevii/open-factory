import type { HarnessEvent } from "@open-factory/shared";

// Stream-json is untyped JSON from another program; read it defensively.
// biome-ignore lint/suspicious/noExplicitAny: stream-json lines are parsed JSON
type Json = Record<string, any>;

interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface MapperState {
  readonly resumed: boolean;
  onUnmapped: (kind: string) => void;
  sawInit: boolean;
  sessionStarted: boolean;
  lastModel: string | undefined;
  heldCompacted: Extract<HarnessEvent, { type: "compacted" }> | undefined;
  foregroundTasks: Set<string>;
  cronCreateCalls: Set<string>;
  errorThisTurn: boolean;
  cronWakeupPending: boolean;
  /** Set by ClaudeProcess when it writes `/compact`; cleared by the compact `result`. */
  manualCompactPending: boolean;
  prevCost: number;
  prevModelUsage: Record<string, ModelUsage>;
  reported: Set<string>;
}

export function createMapperState(opts: {
  resumed: boolean;
  onUnmapped?: (kind: string) => void;
}): MapperState {
  return {
    resumed: opts.resumed,
    onUnmapped: opts.onUnmapped ?? (() => {}),
    sawInit: false,
    sessionStarted: false,
    lastModel: undefined,
    heldCompacted: undefined,
    foregroundTasks: new Set(),
    cronCreateCalls: new Set(),
    errorThisTurn: false,
    cronWakeupPending: false,
    manualCompactPending: false,
    prevCost: 0,
    prevModelUsage: {},
    reported: new Set(),
  };
}

/** Drops on purpose (spec §6.2). Anything else unknown is reported once via onUnmapped. */
const DROPPED_SYSTEM = new Set([
  "thinking_tokens",
  "commands_changed",
  "task_updated",
  "task_progress",
  "informational",
]);
/** Spec §6.2 drops every `hook_*` subtype, not just the ones seen so far. */
const isDroppedSystem = (subtype: unknown) =>
  typeof subtype === "string" && (DROPPED_SYSTEM.has(subtype) || subtype.startsWith("hook_"));

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: Json) =>
      b?.type === "text"
        ? String(b.text ?? "")
        : b?.type
          ? `[${b.type}${b.tool_name ? ` ${b.tool_name}` : ""}]`
          : "",
    )
    .filter(Boolean)
    .join("\n");
};

const parentOf = (e: Json) =>
  e.parent_tool_use_id ? { parentToolUseId: String(e.parent_tool_use_id) } : {};

function unmapped(kind: string, s: MapperState): HarnessEvent[] {
  if (!s.reported.has(kind)) {
    s.reported.add(kind);
    s.onUnmapped(kind);
  }
  return [];
}

function errorOnce(
  s: MapperState,
  source: "api" | "refusal",
  message: string,
  detail?: string,
): HarnessEvent[] {
  if (s.errorThisTurn) return [];
  s.errorThisTurn = true;
  return [{ type: "error", source, message, ...(detail ? { detail } : {}) }];
}

function system(e: Json, s: MapperState): HarnessEvent[] {
  switch (e.subtype) {
    case "init": {
      const out: HarnessEvent[] = [];
      s.sawInit = true;
      s.lastModel = e.model;
      s.errorThisTurn = false;
      if (!s.sessionStarted) {
        s.sessionStarted = true;
        out.push({
          type: "session_started",
          sessionId: String(e.session_id),
          model: String(e.model ?? ""),
          cwd: String(e.cwd ?? ""),
          claudeCodeVersion: String(e.claude_code_version ?? ""),
        });
      }
      out.push({ type: "turn_started" });
      return out;
    }
    case "status":
      if (e.compact_result === "failed")
        return [
          {
            type: "compact_failed",
            trigger: s.manualCompactPending ? "manual" : "auto",
            error: String(e.compact_error ?? "unknown"),
          },
        ];
      return [];
    case "compact_boundary": {
      const m = e.compact_metadata ?? {};
      s.heldCompacted = {
        type: "compacted",
        trigger: m.trigger === "manual" ? "manual" : "auto",
        preTokens: Number(m.pre_tokens ?? 0),
        postTokens: Number(m.post_tokens ?? 0),
      };
      return [];
    }
    case "permission_denied":
      return [
        {
          type: "permission_denied",
          toolName: String(e.tool_name ?? ""),
          toolUseId: String(e.tool_use_id ?? ""),
          reasonType: String(e.decision_reason_type ?? ""),
          reason: String(e.decision_reason ?? e.message ?? ""),
        },
      ];
    case "task_started":
      if (e.is_backgrounded !== true) {
        s.foregroundTasks.add(String(e.task_id));
        return [];
      }
      return [
        {
          type: "background_task_started",
          taskId: String(e.task_id),
          ...(e.tool_use_id ? { toolUseId: String(e.tool_use_id) } : {}),
          taskType: String(e.task_type ?? "unknown"),
          ...(e.description ? { description: String(e.description) } : {}),
        },
      ];
    case "task_notification": {
      const id = String(e.task_id);
      if (s.foregroundTasks.delete(id)) return [];
      return [
        {
          type: "background_task_finished",
          taskId: id,
          status: String(e.status ?? "unknown"),
          summary: String(e.summary ?? ""),
        },
      ];
    }
    case "background_tasks_changed":
      return [
        {
          type: "background_tasks",
          tasks: (Array.isArray(e.tasks) ? e.tasks : []).map((t: Json) => ({
            taskId: String(t.task_id),
            taskType: String(t.task_type ?? "unknown"),
            ...(t.description ? { description: String(t.description) } : {}),
            ...(typeof t.ambient === "boolean" ? { ambient: t.ambient } : {}),
          })),
        },
      ];
    case "model_refusal_no_fallback":
      return errorOnce(
        s,
        "refusal",
        e.api_refusal_explanation
          ? String(e.api_refusal_explanation)
          : "The model declined to continue this conversation.",
        e.api_refusal_category ? `category: ${e.api_refusal_category}` : undefined,
      );
    case "model_refusal_fallback":
      return [
        {
          type: "model_fallback",
          message: String(e.message ?? e.fallback_model ?? "A fallback model took over"),
        },
      ];
    default:
      if (isDroppedSystem(e.subtype)) return [];
      return unmapped(`system/${e.subtype}`, s);
  }
}

function assistant(e: Json, s: MapperState): HarnessEvent[] {
  const msg = e.message ?? {};
  if (msg.model === "<synthetic>") {
    if (e.local_command_source) return []; // duplicates compact_failed
    if (e.error || msg.stop_reason === "refusal")
      return errorOnce(
        s,
        msg.stop_reason === "refusal" ? "refusal" : "api",
        textOf(msg.content) || String(e.error),
      );
    return [];
  }
  const out: HarnessEvent[] = [];
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (b.type === "text" && b.text)
      out.push({ type: "assistant_text", text: String(b.text), ...parentOf(e) });
    else if (b.type === "tool_use") {
      out.push({
        type: "tool_call",
        toolUseId: String(b.id),
        name: String(b.name),
        input: b.input ?? {},
        ...parentOf(e),
      });
      if (b.name === "CronCreate") s.cronCreateCalls.add(String(b.id));
      if (b.name === "CronDelete" && b.input?.id)
        out.push({ type: "cron_deleted", cronId: String(b.input.id) });
    }
    // thinking blocks are dropped (all S0 thinking blocks are empty)
  }
  if (msg.stop_reason === "refusal")
    out.push(...errorOnce(s, "refusal", "The model refused this request."));
  return out;
}

function user(e: Json, s: MapperState): HarnessEvent[] {
  if (e.isReplay) return [];
  const content = e.message?.content;
  if (!Array.isArray(content)) return [];
  const out: HarnessEvent[] = [];
  for (const b of content) {
    if (b.type !== "tool_result") continue; // plain user text (interrupt notes, synthetic text) is dropped
    out.push({
      type: "tool_result",
      toolUseId: String(b.tool_use_id),
      content: textOf(b.content),
      isError: b.is_error === true,
      ...parentOf(e),
    });
    const r = e.tool_use_result;
    if (s.cronCreateCalls.has(String(b.tool_use_id)) && r?.id) {
      s.cronCreateCalls.delete(String(b.tool_use_id));
      out.push({
        type: "cron_created",
        cronId: String(r.id),
        recurring: r.recurring === true,
        humanSchedule: String(r.humanSchedule ?? ""),
        nextFireAt: Number(r.nextFireAt ?? 0),
      });
    }
  }
  return out;
}

function usageOf(e: Json, s: MapperState): HarnessEvent {
  const cumulative: Record<string, ModelUsage> = e.modelUsage ?? {};
  let per: Record<string, ModelUsage> = e.model_usage_since_last_result ?? {};
  let cost: number;
  if (e.model_usage_since_last_result) {
    cost = Object.values(per).reduce((a, u) => a + (u.costUSD ?? 0), 0);
  } else {
    per = {};
    for (const [k, u] of Object.entries(cumulative)) {
      const p = s.prevModelUsage[k] ?? {};
      per[k] = {
        inputTokens: (u.inputTokens ?? 0) - (p.inputTokens ?? 0),
        outputTokens: (u.outputTokens ?? 0) - (p.outputTokens ?? 0),
        cacheReadInputTokens: (u.cacheReadInputTokens ?? 0) - (p.cacheReadInputTokens ?? 0),
        cacheCreationInputTokens:
          (u.cacheCreationInputTokens ?? 0) - (p.cacheCreationInputTokens ?? 0),
        costUSD: (u.costUSD ?? 0) - (p.costUSD ?? 0),
      };
    }
    cost = Number(e.total_cost_usd ?? 0) - s.prevCost;
  }
  s.prevModelUsage = cumulative;
  s.prevCost = Number(e.total_cost_usd ?? s.prevCost);
  const entries = Object.entries(per);
  const sum = (f: keyof ModelUsage) => entries.reduce((a, [, u]) => a + Number(u[f] ?? 0), 0);
  const top = [...entries].sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0))[0];
  return {
    type: "usage",
    model: top?.[0] ?? s.lastModel ?? "unknown",
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadInputTokens"),
    cacheWriteTokens: sum("cacheCreationInputTokens"),
    costUsd: Math.max(0, cost),
    durationMs: Number(e.duration_ms ?? 0),
    numTurns: Number(e.num_turns ?? 0),
  };
}

function result(e: Json, s: MapperState): HarnessEvent[] {
  if (!s.sawInit) {
    const message =
      Array.isArray(e.errors) && e.errors[0]
        ? String(e.errors[0])
        : "Claude Code exited before starting a session";
    return [{ type: "error", source: s.resumed ? "resume" : "spawn", message }];
  }
  const out: HarnessEvent[] = [];
  if (e.is_error === true && e.terminal_reason === "api_error")
    out.push(
      ...errorOnce(s, "api", typeof e.result === "string" && e.result ? e.result : "API error"),
    );
  if (e.stop_reason === "refusal")
    out.push(...errorOnce(s, "refusal", "The model refused this request."));
  out.push(usageOf(e, s));
  const originKind = e.origin?.kind
    ? String(e.origin.kind)
    : s.cronWakeupPending
      ? "cron"
      : undefined;
  out.push({
    type: "turn_end",
    isError: e.is_error === true,
    ...(e.terminal_reason ? { terminalReason: String(e.terminal_reason) } : {}),
    ...(originKind ? { originKind } : {}),
    ...(e.local_command ? { command: String(e.local_command) } : {}),
    numTurns: Number(e.num_turns ?? 0),
  });
  s.cronWakeupPending = false;
  if (e.local_command === "compact") s.manualCompactPending = false;
  return out;
}

export function mapLine(line: unknown, s: MapperState): HarnessEvent[] {
  const e = (line ?? {}) as Json;
  const out: HarnessEvent[] = [];
  if (s.heldCompacted) {
    const held = s.heldCompacted;
    s.heldCompacted = undefined;
    if (e.type === "user" && e.isSynthetic === true && !e.isReplay) {
      const summary = textOf(e.message?.content);
      out.push(summary ? { ...held, summary } : held);
      return out;
    }
    out.push(held);
  }
  switch (e.type) {
    case "system":
      out.push(...system(e, s));
      break;
    case "assistant":
      out.push(...assistant(e, s));
      break;
    case "user":
      out.push(...user(e, s));
      break;
    case "result":
      out.push(...result(e, s));
      break;
    case "rate_limit_event": {
      const i = e.rate_limit_info ?? {};
      if (i.status === "rejected")
        out.push({
          type: "rate_limited",
          status: "rejected",
          resetsAt: Number(i.resetsAt ?? 0),
          rateLimitType: String(i.rateLimitType ?? "unknown"),
          ...(typeof i.utilization === "number" ? { utilization: i.utilization } : {}),
        });
      break;
    }
    case "command_lifecycle":
      if (e.state === "started" && e.wakeup_source) s.cronWakeupPending = true;
      break;
    case "control_response":
      break;
    default:
      out.push(...unmapped(String(e.type), s));
  }
  return out;
}

/** End of stream: emit a compacted event still waiting for its summary. */
export function flushMapper(s: MapperState): HarnessEvent[] {
  const held = s.heldCompacted;
  s.heldCompacted = undefined;
  return held ? [held] : [];
}
