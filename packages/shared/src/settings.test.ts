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

test("patchFactorySettingsSchema bounds the loop guard fields", () => {
  const message = (body: object) =>
    patchFactorySettingsSchema.safeParse(body).error?.issues[0]?.message;
  for (const limit of [1, 1001]) {
    expect(message({ loopGuardMessages: limit })).toBe("Enter a whole number from 2 to 1000.");
  }
  for (const limit of [2, 1000]) {
    expect(patchFactorySettingsSchema.safeParse({ loopGuardMessages: limit }).success).toBe(true);
  }
  for (const window of [0, 1441]) {
    expect(message({ loopGuardWindowMinutes: window })).toBe(
      "Enter a whole number from 1 to 1440.",
    );
  }
  for (const window of [1, 1440]) {
    expect(patchFactorySettingsSchema.safeParse({ loopGuardWindowMinutes: window }).success).toBe(
      true,
    );
  }
});
