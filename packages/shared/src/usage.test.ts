import { expect, test } from "vitest";
import { usageDaysSchema } from "./usage.ts";

test("usageDaysSchema accepts 7, 30, 90 as strings and refuses others", () => {
  expect(usageDaysSchema.parse("7")).toBe(7);
  expect(usageDaysSchema.parse("30")).toBe(30);
  expect(usageDaysSchema.parse("90")).toBe(90);
  expect(usageDaysSchema.safeParse("14").success).toBe(false);
});
