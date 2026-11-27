import { expect, test } from "vitest";
import { MSG } from "./messages.ts";
import { nameSchema } from "./names.ts";

/** Messages whose exact copy comes from the spec (§4.5 handle errors) and is longer than the usual 40. */
const SPEC_OVER_LIMIT: Partial<Record<keyof typeof MSG, number>> = { handleChars: 42 };

test("every field message is at most 40 characters, bar the spec's named exceptions", () => {
  for (const [k, m] of Object.entries(MSG))
    expect(m.length, k).toBeLessThanOrEqual(SPEC_OVER_LIMIT[k as keyof typeof MSG] ?? 40);
  expect(MSG.handleChars.length).toBe(SPEC_OVER_LIMIT.handleChars);
});

const first = (v: string) => nameSchema.safeParse(v).error?.issues[0]?.message;

test("nameSchema reports one rule at a time, in a stable order", () => {
  expect(first("9ab")).toBe(MSG.startLetter);
  expect(first("a")).toBe(MSG.nameLength);
  expect(first("ab-")).toBe(MSG.noTrailingHyphen);
  expect(first("a_b")).toBe(MSG.nameChars);
});
