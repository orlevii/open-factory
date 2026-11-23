import { expect, test } from "vitest";
import { MSG } from "./messages.ts";
import { slugSchema } from "./names.ts";

test("every field message is at most 40 characters", () => {
  for (const [k, m] of Object.entries(MSG)) expect(m.length, k).toBeLessThanOrEqual(40);
});

const first = (v: string) => slugSchema.safeParse(v).error?.issues[0]?.message;

test("slugSchema reports one rule at a time, in a stable order", () => {
  expect(first("9ab")).toBe(MSG.startLetter);
  expect(first("ab")).toBe(MSG.slugLength);
  expect(first("ab-")).toBe(MSG.noTrailingHyphen);
  expect(first("a_b")).toBe(MSG.nameChars);
});
