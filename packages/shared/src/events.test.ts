import { describe, expect, test } from "vitest";
import {
  anyEventSchema,
  MAX_BODY_BYTES,
  sendMessageBodySchema,
  sessionEventSchema,
} from "./index.ts";

describe("event schemas", () => {
  test("accepts every harness and factory event type", () => {
    const samples = [
      {
        type: "session_started",
        sessionId: "s",
        model: "m",
        cwd: "/w",
        claudeCodeVersion: "2.1.327",
      },
      { type: "turn_started" },
      {
        type: "message_in",
        messages: [{ id: "m1", from: "@or", kind: "message", urgent: false, body: "hi" }],
      },
      { type: "assistant_text", text: "hello" },
      { type: "tool_call", toolUseId: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", toolUseId: "t1", content: "a\nb", isError: false },
      { type: "background_task_started", taskId: "b1", toolUseId: "t1", taskType: "local_bash" },
      { type: "background_task_finished", taskId: "b1", status: "completed", summary: "done" },
      { type: "background_tasks", tasks: [{ taskId: "b1", taskType: "local_bash" }] },
      {
        type: "cron_created",
        cronId: "c1",
        recurring: true,
        humanSchedule: "Every minute",
        nextFireAt: 1,
      },
      { type: "cron_deleted", cronId: "c1" },
      {
        type: "permission_denied",
        toolName: "Bash",
        toolUseId: "t1",
        reasonType: "classifier",
        reason: "r",
      },
      { type: "compacted", trigger: "manual", preTokens: 27545, postTokens: 15259, summary: "s" },
      { type: "compact_failed", trigger: "auto", error: "too_few_groups" },
      { type: "model_fallback", message: "m" },
      {
        type: "usage",
        model: "m",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 0.1,
        durationMs: 5,
        numTurns: 1,
      },
      {
        type: "rate_limited",
        status: "rejected",
        resetsAt: 1795027800,
        rateLimitType: "five_hour",
      },
      { type: "turn_end", isError: false, terminalReason: "completed", numTurns: 1 },
      { type: "error", source: "resume", message: "No conversation found" },
      { type: "exited", code: 0, signal: null, stderrTail: "", expected: true },
      { type: "process_started", resumed: true },
      { type: "control", cmd: "interrupt", by: "@or" },
      { type: "delivery_failed", messageIds: ["m1"], reason: "exited" },
      { type: "session_reset", by: "seed script" },
    ];
    for (const s of samples) expect(anyEventSchema.parse(s)).toEqual(s);
  });

  test("rejects an unknown type", () => {
    expect(anyEventSchema.safeParse({ type: "nope" }).success).toBe(false);
  });

  test("session event DTO nests the event", () => {
    const dto = {
      seq: 3,
      agentSlug: "dev",
      turnId: null,
      at: "2026-11-18T00:00:00.000Z",
      event: { type: "turn_started" },
      truncated: { "event.content": 2_000_000 },
    };
    expect(sessionEventSchema.parse(dto)).toEqual(dto);
  });
});

describe("sendMessageBodySchema", () => {
  test("trims and rejects empty", () => {
    expect(sendMessageBodySchema.safeParse({ body: "   ", urgent: false }).success).toBe(false);
    expect(sendMessageBodySchema.parse({ body: " hi ", urgent: true })).toEqual({
      body: "hi",
      urgent: true,
    });
  });
  test("limits UTF-8 bytes, not chars", () => {
    const ok = "é".repeat(MAX_BODY_BYTES / 2);
    const tooBig = `${ok}x`;
    expect(sendMessageBodySchema.safeParse({ body: ok, urgent: false }).success).toBe(true);
    expect(sendMessageBodySchema.safeParse({ body: tooBig, urgent: false }).success).toBe(false);
  });
});
