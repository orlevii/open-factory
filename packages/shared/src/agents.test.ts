import { expect, test } from "vitest";
import {
  agentListQuerySchema,
  agentSummarySchema,
  createAgentBodySchema,
  patchAgentBodySchema,
  queueItemSchema,
  sendMessagesBodySchema,
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
  expect(terminateAgentToolSchema.safeParse({ target: "@tech-lead-ab12" }).success).toBe(true);
  expect(terminateAgentToolSchema.safeParse({}).success).toBe(false);
});
test("list query: ended defaults to exclude", () => {
  expect(agentListQuerySchema.parse({})).toEqual({ ended: "exclude" });
});

test("agent summary avatarVersion defaults to null", () => {
  const base = agentSummarySchema.shape;
  expect(base.avatarVersion.parse(undefined)).toBeNull();
  expect(base.avatarVersion.parse("v1")).toBe("v1");
});

test("queue items accept the stopping wait reason and a client id", () => {
  const q = queueItemSchema.parse({
    id: "m1",
    kind: "message",
    from: "@or",
    fromKind: "human",
    createdAt: "2026-11-21T10:00:00.000Z",
    waitReason: "stopping",
    clientMessageId: crypto.randomUUID(),
  });
  expect(q.waitReason).toBe("stopping");
  expect(q.fromKind).toBe("human");
  expect(
    queueItemSchema.safeParse({ id: "m1", kind: "message", from: "@or", createdAt: "x" }).success,
  ).toBe(false);
});
test("send body: clientMessageId is an optional UUID (the idempotency key)", () => {
  const id = crypto.randomUUID();
  expect(
    sendMessagesBodySchema.parse({ to: ["dev"], body: "hi", clientMessageId: id }).clientMessageId,
  ).toBe(id);
  expect(sendMessagesBodySchema.parse({ to: ["dev"], body: "hi" }).clientMessageId).toBeUndefined();
  expect(
    sendMessagesBodySchema.safeParse({ to: ["dev"], body: "hi", clientMessageId: "not-a-uuid" })
      .success,
  ).toBe(false);
});

test("PATCH colour is an int 1..12 or null", () => {
  for (const color of [1, 12, null])
    expect(patchAgentBodySchema.safeParse({ color }).success).toBe(true);
  for (const color of [0, 13, 1.5, "3"])
    expect(patchAgentBodySchema.safeParse({ color }).success).toBe(false);
});

test("PATCH manageOrg must be a boolean", () => {
  expect(patchAgentBodySchema.safeParse({ manageOrg: "yes" }).success).toBe(false);
  expect(patchAgentBodySchema.safeParse({ manageOrg: true }).success).toBe(true);
});

test("create body accepts manageOrg as a boolean", () => {
  const valid = {
    template: "lead",
    slug: "boss",
    displayName: "Boss",
    description: "",
    reportsTo: "@or",
    credential: "default",
  };
  expect(createAgentBodySchema.parse({ ...valid, manageOrg: true }).manageOrg).toBe(true);
  expect(createAgentBodySchema.safeParse({ ...valid, manageOrg: "yes" }).success).toBe(false);
});

test.each([
  ["@or", "or"],
  ["or", "or"],
  [" @lead-dev ", "lead-dev"],
])("a manager reference %j is read as the handle %j", (given, handle) => {
  expect(patchAgentBodySchema.parse({ reportsTo: given }).reportsTo).toBe(handle);
});

test.each([null, "", "@", "  "])("a create body without a manager (%j) is refused", (reportsTo) => {
  const body = {
    template: "lead",
    slug: "boss",
    displayName: "Boss",
    description: "",
    reportsTo,
    credential: "default",
  };
  expect(createAgentBodySchema.safeParse(body).success).toBe(false);
});
