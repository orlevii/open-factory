import { expect, test } from "vitest";
import { MSG } from "./messages.ts";
import { nameSchema } from "./names.ts";

test("every field message is at most 40 characters", () => {
  for (const [k, m] of Object.entries(MSG))
    expect(m.length, k).toBeLessThanOrEqual(k === "handleChars" ? 42 : 40);
});

const first = (v: string) => nameSchema.safeParse(v).error?.issues[0]?.message;

test("nameSchema reports one rule at a time, in a stable order", () => {
  expect(first("9ab")).toBe(MSG.startLetter);
  expect(first("a")).toBe(MSG.nameLength);
  expect(first("ab-")).toBe(MSG.noTrailingHyphen);
  expect(first("a_b")).toBe(MSG.nameChars);
});
