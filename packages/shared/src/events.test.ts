import { describe, expect, test } from "vitest";
import {
  anyEventSchema,
  MAX_BODY_BYTES,
  sendMessagesBodySchema,
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
        messages: [
          {
            id: "m1",
            from: "@or",
            fromKind: "human",
            kind: "message",
            urgent: false,
            body: "hi",
            parts: [{ id: "m1", body: "hi", createdAt: "2026-11-24T10:00:00.000Z" }],
          },
        ],
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
      { type: "error", source: "api", message: "x", code: "authentication_failed" },
      { type: "error", source: "spawn", message: "x", fix: "secrets" },
      { type: "error", source: "spawn", message: "x", fix: "runtime" },
      { type: "error", source: "spawn", message: "m", fix: "image" },
      { type: "turn_end", isError: true, numTurns: 1, apiErrorStatus: 401 },
      {
        type: "message_in",
        messages: [
          {
            id: "n1",
            from: "@factory",
            fromKind: "factory",
            kind: "system",
            urgent: false,
            body: "x",
            parts: [{ id: "n1", body: "x", createdAt: "2026-11-24T10:00:00.000Z" }],
          },
        ],
      },
      { type: "hibernated", reason: "warm_window", idleMinutes: 70 },
      { type: "container", action: "created", image: "open-factory-base:dev", imageId: "sha256:x" },
      { type: "cleanup", killedProcesses: 2 },
      { type: "stop_escalated", how: "sigkill" },
      {
        type: "background_work_lost",
        reason: "crash",
        tasks: [{ taskId: "t", description: "pnpm test" }],
        crons: [],
      },
      { type: "background_work_lost", reason: "terminated", tasks: [], crons: [] },
      { type: "reconciled", killedProcesses: 0, stoppedContainer: true },
      {
        type: "rate_limit_paused",
        credential: "work",
        until: "2026-11-19T14:30:00Z",
        exact: false,
      },
      { type: "rate_limit_reset", credential: "work" },
      { type: "control", cmd: "restart", by: "@or" },
      { type: "process_started", resumed: true, reason: "crash_recovery" },
      { type: "process_started", resumed: false, reason: "spawned" },
      { type: "spawned", by: "lead", template: "tech-lead" },
      { type: "terminated", by: "@factory" },
      {
        type: "message_in",
        messages: [
          {
            id: "m",
            from: "@factory",
            fromKind: "factory",
            kind: "peer_left",
            urgent: false,
            body: "",
            parts: [{ id: "m", body: "", createdAt: "2026-11-24T10:00:00.000Z" }],
            subject: {
              slug: "x",
              displayName: "X",
              relation: "peer",
              left: { reason: "terminated", by: "@or" },
            },
          },
        ],
      },
      {
        type: "rate_limit_status",
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.9,
        resetsAt: 1,
      },
      { type: "interrupt_unconfirmed" },
      {
        type: "workspace_cleanup",
        projects: [
          {
            project: "web",
            removed: true,
            deleted: ["feat/y"],
            kept: [
              { branch: "feat/x", commits: 3 },
              { branch: "feat/z", reason: "elsewhere" },
            ],
          },
          {
            project: "docs",
            removed: false,
            deleted: [],
            kept: [],
            error: "couldn't clean up: not a git repository",
          },
        ],
      },
    ];
    for (const s of samples) expect(anyEventSchema.parse(s)).toEqual(s);
  });

  test("rejects an unknown type and an unknown spawn error fix", () => {
    expect(anyEventSchema.safeParse({ type: "nope" }).success).toBe(false);
    expect(
      anyEventSchema.safeParse({ type: "error", source: "spawn", message: "x", fix: "nope" })
        .success,
    ).toBe(false);
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

describe("sendMessagesBodySchema", () => {
  test("trims and rejects empty", () => {
    expect(
      sendMessagesBodySchema.safeParse({ to: ["dev"], body: "   ", urgent: false }).success,
    ).toBe(false);
    expect(sendMessagesBodySchema.parse({ to: ["dev"], body: " hi ", urgent: true })).toEqual({
      to: ["dev"],
      body: "hi",
      urgent: true,
    });
  });
  test("limits UTF-8 bytes, not chars", () => {
    const ok = "é".repeat(MAX_BODY_BYTES / 2);
    const tooBig = `${ok}x`;
    expect(sendMessagesBodySchema.safeParse({ to: ["dev"], body: ok, urgent: false }).success).toBe(
      true,
    );
    expect(
      sendMessagesBodySchema.safeParse({ to: ["dev"], body: tooBig, urgent: false }).success,
    ).toBe(false);
  });
});

describe("reconcile keys and Agent usage (U3 §11.1, §9.1)", () => {
  test("assistant_text and tool_call keep messageId and blockIndex", () => {
    const text = anyEventSchema.parse({
      type: "assistant_text",
      text: "hi",
      messageId: "msg_1",
      blockIndex: 1,
    });
    expect(text).toEqual({ type: "assistant_text", text: "hi", messageId: "msg_1", blockIndex: 1 });
    const call = anyEventSchema.parse({
      type: "tool_call",
      toolUseId: "t1",
      name: "Write",
      input: {},
      messageId: "msg_1",
      blockIndex: 2,
    });
    expect(call).toMatchObject({ messageId: "msg_1", blockIndex: 2 });
    expect(
      anyEventSchema.safeParse({ type: "assistant_text", text: "x", blockIndex: 1.5 }).success,
    ).toBe(false);
  });

  test("background_task_finished carries optional usage", () => {
    const done = anyEventSchema.parse({
      type: "background_task_finished",
      taskId: "b1",
      status: "completed",
      summary: "ok",
      usage: { toolUses: 4, tokens: 23000, durationMs: 41000 },
    });
    expect(done).toMatchObject({ usage: { toolUses: 4, tokens: 23000, durationMs: 41000 } });
    expect(
      anyEventSchema.safeParse({
        type: "background_task_finished",
        taskId: "b1",
        status: "completed",
        summary: "ok",
        usage: { toolUses: 4 },
      }).success,
    ).toBe(false);
  });
});
