import { expect, test } from "vitest";
import { createAgentToolSchema, updateAgentToolSchema } from "./org-tools.ts";

test("update_agent: a config without base_hash is refused and names base_hash", () => {
  const r = updateAgentToolSchema.safeParse({ slug: "dev", config: {} });
  expect(r.success).toBe(false);
  expect(r.error?.issues[0]).toMatchObject({ path: ["base_hash"] });
});

test("update_agent: config with base_hash, and identity fields alone, pass", () => {
  expect(
    updateAgentToolSchema.safeParse({ slug: "dev", config: {}, base_hash: "abc" }).success,
  ).toBe(true);
  expect(updateAgentToolSchema.safeParse({ slug: "dev", display_name: "Dev" }).success).toBe(true);
});

test("create_agent: has no way to set manage_org", () => {
  const r = createAgentToolSchema.safeParse({
    template: "dev",
    name: "dev-1",
    display_name: "Dev",
    description: "",
    credential: "work",
    manage_org: true,
  });
  expect(r.success && "manage_org" in r.data).toBe(false);
});

test("create_agent: an overlay with an unknown top-level key is refused", () => {
  const r = createAgentToolSchema.safeParse({
    template: "dev",
    name: "dev-1",
    display_name: "Dev",
    description: "",
    credential: "work",
    config: { manage_org: true },
  });
  expect(r.success).toBe(false);
});
