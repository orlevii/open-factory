import { describe, expect, test } from "vitest";
import {
  anyEventSchema,
  MAX_BODY_BYTES,
  sendMessagesBodySchema,
  sessionEventSchema,
} from "./index.ts";

describe("event schemas", () => {
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
