import { expect, test } from "vitest";
import { queueItemSchema } from "./agents.ts";
import { anyEventSchema } from "./events.ts";
import { handleSchema, RESERVED_HANDLES } from "./handle.ts";
import { isReservedSecretName } from "./names.ts";
import { serverMessageSchema } from "./ws.ts";

test("a pre-S6 message_in row (no parts) still parses", () => {
  const e = {
    type: "message_in",
    messages: [{ id: "m1", from: "@or", kind: "message", urgent: false, body: "hi" }],
  };
  expect(anyEventSchema.parse(e)).toEqual(e);
});

test("a merged member_update envelope with parts and a factory fact parse", () => {
  const e = {
    type: "message_in",
    messages: [
      {
        id: "m1",
        ids: ["m1", "m2"],
        from: "dev",
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
        kind: "member_update",
        about: "dev",
        fact: "denied",
        urgent: false,
        body: "Bash was denied for @dev.",
      },
      {
        id: "m4",
        from: "@factory",
        kind: "peer_left",
        about: "dev",
        urgent: false,
        body: "…",
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
      from: "dev",
      count: 3,
      waitReason: "window",
      dueAt: "2026-11-19T10:00:30.000Z",
      createdAt: "2026-11-19T10:00:00.000Z",
    }).kind,
  ).toBe("held");
  expect(serverMessageSchema.parse({ type: "inbox_changed" })).toEqual({ type: "inbox_changed" });
});

test("all and system are reserved handles; OPEN_FACTORY_ secrets are reserved", () => {
  expect(RESERVED_HANDLES).toEqual(expect.arrayContaining(["all", "system"]));
  expect(handleSchema.safeParse("system").success).toBe(false);
  expect(isReservedSecretName("OPEN_FACTORY_AGENT_TOKEN")).toBe(true);
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
