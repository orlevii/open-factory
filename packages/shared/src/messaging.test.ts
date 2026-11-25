import { expect, test } from "vitest";
import { queueItemSchema } from "./agents.ts";
import { anyEventSchema } from "./events.ts";
import { readFromBodySchema, readFromResponseSchema, unreadCountSchema } from "./messaging.ts";
import { serverMessageSchema } from "./ws.ts";

test("a merged member_update envelope with parts and a factory fact parse", () => {
  const e = {
    type: "message_in",
    messages: [
      {
        id: "m1",
        ids: ["m1", "m2"],
        from: "@dev",
        fromKind: "agent",
        kind: "member_update",
        urgent: false,
        body: "a\n\nb",
        parts: [
          { id: "m1", body: "a", createdAt: "2026-11-19T10:00:00.000Z" },
          { id: "m2", body: "b", createdAt: "2026-11-19T10:00:01.000Z" },
        ],
      },
      {
        id: "m3",
        from: "@factory",
        fromKind: "factory",
        kind: "member_update",
        about: "dev",
        fact: "denied",
        urgent: false,
        body: "Bash was denied for @dev.",
        parts: [
          { id: "m3", body: "Bash was denied for @dev.", createdAt: "2026-11-24T10:00:00.000Z" },
        ],
      },
      {
        id: "m4",
        from: "@factory",
        fromKind: "factory",
        kind: "peer_left",
        about: "dev",
        urgent: false,
        body: "…",
        parts: [{ id: "m4", body: "…", createdAt: "2026-11-24T10:00:00.000Z" }],
        subject: {
          slug: "dev",
          displayName: "Dev",
          relation: "peer",
          left: { reason: "moved", to: null },
        },
      },
    ],
  };
  expect(anyEventSchema.parse(e)).toEqual(e);
});

test("held queue items and the inbox frame parse", () => {
  expect(
    queueItemSchema.parse({
      id: "m1",
      kind: "held",
      from: "@dev",
      fromKind: "agent",
      count: 3,
      waitReason: "window",
      dueAt: "2026-11-19T10:00:30.000Z",
      createdAt: "2026-11-19T10:00:00.000Z",
    }).kind,
  ).toBe("held");
  expect(serverMessageSchema.parse({ type: "inbox_changed" })).toEqual({ type: "inbox_changed" });
});

test("process_started accepts the S6 wake reasons; mcp_unavailable parses", () => {
  expect(
    anyEventSchema.parse({ type: "process_started", resumed: true, reason: "agent_message" }),
  ).toBeTruthy();
  expect(
    anyEventSchema.parse({ type: "process_started", resumed: true, reason: "member_updates" }),
  ).toBeTruthy();
  expect(anyEventSchema.parse({ type: "mcp_unavailable", status: "failed" })).toBeTruthy();
});

test("unread count carries byAgent and defaults it", () => {
  expect(unreadCountSchema.parse({ count: 2 })).toEqual({ count: 2, byAgent: {} });
  expect(unreadCountSchema.parse({ count: 2, byAgent: { ada: 2 } }).byAgent).toEqual({ ada: 2 });
});

test("read-from body and response", () => {
  expect(readFromBodySchema.safeParse({ upTo: "" }).success).toBe(false);
  expect(
    readFromResponseSchema.parse({ marked: 1, readAt: "2026-11-21T00:00:00.000Z" }).marked,
  ).toBe(1);
});
