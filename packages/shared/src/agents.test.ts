import { expect, test } from "vitest";
import {
  agentListQuerySchema,
  agentSummarySchema,
  patchAgentBodySchema,
  queueItemSchema,
  sendMessageBodySchema,
  spawnAgentToolSchema,
  terminateAgentToolSchema,
} from "./agents.ts";

test("PATCH body is strict: template and slug are rejected, not dropped", () => {
  expect(patchAgentBodySchema.safeParse({ description: "x" }).success).toBe(true);
  expect(patchAgentBodySchema.safeParse({}).success).toBe(true);
  expect(patchAgentBodySchema.safeParse({ template: "lead" }).success).toBe(false);
  expect(patchAgentBodySchema.safeParse({ slug: "boss", description: "x" }).success).toBe(false);
});

test("spawn tool schema: enum from the caller's templates, suffix pattern, required fields", () => {
  const s = spawnAgentToolSchema(["tech-lead", "developer"]);
  expect(s.safeParse({ template: "developer", description: "d", prompt: "p" }).success).toBe(true);
  expect(s.safeParse({ template: "ghost", description: "d", prompt: "p" }).success).toBe(false);
  expect(
    s.safeParse({ template: "developer", suffix: "Bad", description: "d", prompt: "p" }).success,
  ).toBe(false);
  expect(s.safeParse({ template: "developer", description: "d" }).success).toBe(false);
  expect(
    s.safeParse({ template: "developer", description: "d", prompt: "p", extra: 1 }).success,
  ).toBe(false);
});
test("terminate tool schema", () => {
  expect(terminateAgentToolSchema.safeParse({ slug: "@tech-lead-ab12" }).success).toBe(true);
  expect(terminateAgentToolSchema.safeParse({}).success).toBe(false);
});
test("list query: ended defaults to exclude", () => {
  expect(agentListQuerySchema.parse({})).toEqual({ ended: "exclude" });
});
test("list query: the old ?archived= parameter is rejected, not ignored", () => {
  expect(agentListQuerySchema.safeParse({ archived: "only" }).success).toBe(false);
});

test("agent summary avatarVersion defaults to null", () => {
  const base = agentSummarySchema.shape;
  expect(base.avatarVersion.parse(undefined)).toBeNull();
  expect(base.avatarVersion.parse("v1")).toBe("v1");
});

test("agent summary carries turnStartedAt and compacting", () => {
  const shape = agentSummarySchema.shape;
  expect(shape.turnStartedAt.parse("2026-11-21T10:00:00.000Z")).toBe("2026-11-21T10:00:00.000Z");
  expect(shape.compacting.parse(true)).toBe(true);
});
test("queue items accept the stopping wait reason and a client id", () => {
  const q = queueItemSchema.parse({
    id: "m1",
    kind: "message",
    from: "@or",
    createdAt: "2026-11-21T10:00:00.000Z",
    waitReason: "stopping",
    clientMessageId: crypto.randomUUID(),
  });
  expect(q.waitReason).toBe("stopping");
});
test("send body takes an optional clientMessageId", () => {
  const id = crypto.randomUUID();
  expect(sendMessageBodySchema.parse({ body: "hi", clientMessageId: id }).clientMessageId).toBe(id);
});
