import { expect, test } from "vitest";
import {
  agentListQuerySchema,
  agentSummarySchema,
  patchAgentBodySchema,
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
