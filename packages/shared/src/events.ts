import { z } from "zod";

const parent = { parentToolUseId: z.string().optional() };

export const harnessEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_started"),
    sessionId: z.string(),
    model: z.string(),
    cwd: z.string(),
    claudeCodeVersion: z.string(),
  }),
  z.object({ type: z.literal("turn_started") }),
  z.object({
    type: z.literal("message_in"),
    messages: z.array(
      z.object({
        id: z.string(),
        from: z.string(),
        kind: z.enum(["message", "system"]),
        urgent: z.boolean(),
        body: z.string(),
        taskKey: z.string().optional(),
      }),
    ),
  }),
  z.object({ type: z.literal("assistant_text"), text: z.string(), ...parent }),
  z.object({
    type: z.literal("tool_call"),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
    ...parent,
  }),
  z.object({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean(),
    ...parent,
  }),
  z.object({
    type: z.literal("background_task_started"),
    taskId: z.string(),
    toolUseId: z.string().optional(),
    taskType: z.string(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("background_task_finished"),
    taskId: z.string(),
    status: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("background_tasks"),
    tasks: z.array(
      z.object({
        taskId: z.string(),
        taskType: z.string(),
        description: z.string().optional(),
        ambient: z.boolean().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal("cron_created"),
    cronId: z.string(),
    recurring: z.boolean(),
    humanSchedule: z.string(),
    nextFireAt: z.number(),
  }),
  z.object({ type: z.literal("cron_deleted"), cronId: z.string() }),
  z.object({
    type: z.literal("permission_denied"),
    toolName: z.string(),
    toolUseId: z.string(),
    reasonType: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("compacted"),
    trigger: z.enum(["manual", "auto"]),
    preTokens: z.number(),
    postTokens: z.number(),
    summary: z.string().optional(),
  }),
  z.object({
    type: z.literal("compact_failed"),
    trigger: z.enum(["manual", "auto"]),
    error: z.string(),
  }),
  z.object({ type: z.literal("model_fallback"), message: z.string() }),
  z.object({
    type: z.literal("usage"),
    model: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    costUsd: z.number(),
    durationMs: z.number(),
    numTurns: z.number(),
    apiErrorStatus: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("rate_limited"),
    status: z.string(),
    resetsAt: z.number(),
    rateLimitType: z.string(),
    utilization: z.number().optional(),
  }),
  z.object({
    type: z.literal("turn_end"),
    isError: z.boolean(),
    terminalReason: z.string().optional(),
    originKind: z.string().optional(),
    command: z.string().optional(),
    apiErrorStatus: z.number().optional(),
    numTurns: z.number(),
  }),
  z.object({
    type: z.literal("error"),
    source: z.enum(["api", "refusal", "spawn", "resume"]),
    message: z.string(),
    detail: z.string().optional(),
    code: z.string().optional(),
    fix: z
      .enum(["credentials", "secrets", "projects", "edit_agent", "runtime", "resync"])
      .optional(),
  }),
  z.object({
    type: z.literal("exited"),
    code: z.number().nullable(),
    signal: z.string().nullable(),
    stderrTail: z.string(),
    expected: z.boolean(),
  }),
]);
export type HarnessEvent = z.infer<typeof harnessEventSchema>;

/** Appended by the server, never produced by a driver. */
export const factoryEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("process_started"),
    resumed: z.boolean(),
    reason: z
      .enum([
        "message",
        "compact",
        "crash_recovery",
        "restart",
        "reset",
        "boot",
        "boot_resume",
        "rate_limit_reset",
        "queued_items",
        "apply_changes",
      ])
      .optional(),
  }),
  z.object({
    type: z.literal("control"),
    cmd: z.enum(["compact", "interrupt", "clear", "restart"]),
    arg: z.string().optional(),
    by: z.string(),
  }),
  z.object({
    type: z.literal("delivery_failed"),
    messageIds: z.array(z.string()),
    reason: z.string(),
  }),
  z.object({ type: z.literal("session_reset"), by: z.string() }),
  z.object({
    type: z.literal("hibernated"),
    reason: z.string(),
    idleMinutes: z.number().optional(),
  }),
  z.object({
    type: z.literal("container"),
    action: z.enum(["created", "recreated", "started"]),
    image: z.string(),
    imageId: z.string(),
    claudeCodeVersion: z.string().optional(),
  }),
  z.object({
    type: z.literal("cleanup"),
    killedProcesses: z.number().int().nonnegative().optional(),
    container: z.literal("stopped").optional(),
  }),
  z.object({ type: z.literal("stop_escalated"), how: z.enum(["sigkill", "container_stop"]) }),
  z.object({
    type: z.literal("background_work_lost"),
    reason: z.enum([
      "crash",
      "apply_changes",
      "shutdown",
      "archived",
      "restart",
      "factory_restarted",
    ]),
    tasks: z.array(z.object({ taskId: z.string(), description: z.string().optional() })),
    crons: z.array(z.object({ cronId: z.string(), humanSchedule: z.string().optional() })),
  }),
  z.object({
    type: z.literal("reconciled"),
    killedProcesses: z.number().int().nonnegative(),
    stoppedContainer: z.boolean(),
  }),
  z.object({
    type: z.literal("rate_limit_paused"),
    credential: z.string(),
    until: z.string(),
    exact: z.boolean(),
  }),
  z.object({ type: z.literal("rate_limit_reset"), credential: z.string() }),
]);
export type FactoryEvent = z.infer<typeof factoryEventSchema>;

export const anyEventSchema = z.discriminatedUnion("type", [
  ...harnessEventSchema.options,
  ...factoryEventSchema.options,
]);
export type AnyEvent = z.infer<typeof anyEventSchema>;
export type AnyEventType = AnyEvent["type"];

export const sessionEventSchema = z.object({
  seq: z.number().int().positive(),
  agentSlug: z.string(),
  turnId: z.string().nullable(),
  at: z.string(),
  event: anyEventSchema,
  /** field path → original UTF-8 byte length, for strings cut at the 64 KiB cap */
  truncated: z.record(z.string(), z.number()).optional(),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;
