import { expect, test } from "vitest";
import { patchAgentBodySchema } from "./agents.ts";

test("PATCH body is strict: template and slug are rejected, not dropped", () => {
  expect(patchAgentBodySchema.safeParse({ description: "x" }).success).toBe(true);
  expect(patchAgentBodySchema.safeParse({}).success).toBe(true);
  expect(patchAgentBodySchema.safeParse({ template: "lead" }).success).toBe(false);
  expect(patchAgentBodySchema.safeParse({ slug: "boss", description: "x" }).success).toBe(false);
});
