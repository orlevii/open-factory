import { expect, test } from "vitest";
import { patchFactorySettingsSchema } from "./settings.ts";

test("patchFactorySettingsSchema", () => {
  expect(patchFactorySettingsSchema.safeParse({ allowLocalRuntime: true }).success).toBe(false);
  const zero = patchFactorySettingsSchema.safeParse({ maxRunningAgents: 0 });
  expect(zero.success).toBe(false);
  expect(zero.error?.issues[0]?.message).toBe("Enter a whole number from 1 to 64.");
  expect(patchFactorySettingsSchema.safeParse({ memberUpdateDebounceSeconds: 0 }).success).toBe(
    true,
  );
  expect(patchFactorySettingsSchema.safeParse({ maxRunningAgents: 1.5 }).success).toBe(false);
});
