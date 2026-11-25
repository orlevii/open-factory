import { expect, test } from "vitest";
import { factorySettingsValuesSchema, patchFactorySettingsSchema } from "./settings.ts";

test("a patch outside a bound or of the wrong type is refused with the range sentence", () => {
  for (const bad of [
    { warmWindowMinutes: 0 },
    { warmWindowMinutes: 1441 },
    { warmWindowMinutes: 1.5 },
    { memberUpdateDebounceSeconds: -1 },
    { memberUpdateDebounceSeconds: 86_401 },
    { memberUpdateDebounceSeconds: "5" },
  ]) {
    const r = patchFactorySettingsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/^Enter a whole number from \d+ to \d+\.$/);
  }
});

test("a patch is partial and strict: a debounce of 0 is valid, allowLocalRuntime and unknown keys are not", () => {
  expect(patchFactorySettingsSchema.safeParse({ memberUpdateDebounceSeconds: 0 }).success).toBe(
    true,
  );
  expect(patchFactorySettingsSchema.safeParse({}).success).toBe(true);
  expect(patchFactorySettingsSchema.safeParse({ allowLocalRuntime: true }).success).toBe(false);
  expect(patchFactorySettingsSchema.safeParse({ maxRunningAgents: 2 }).success).toBe(false);
});

test("stored values read with a default for every missing key", () => {
  expect(factorySettingsValuesSchema.parse({})).toEqual({
    warmWindowMinutes: 70,
    memberUpdateDebounceSeconds: 30,
  });
  expect(factorySettingsValuesSchema.parse({ warmWindowMinutes: 90 })).toEqual({
    warmWindowMinutes: 90,
    memberUpdateDebounceSeconds: 30,
  });
});
