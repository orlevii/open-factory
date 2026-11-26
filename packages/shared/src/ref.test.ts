import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { normaliseRef, REF_PATTERN, refOf } from "./ref.ts";

test("a ref is 8 chars of the Crockford alphabet for any UUID", () => {
  for (let i = 0; i < 500; i++) expect(refOf(randomUUID())).toMatch(REF_PATTERN);
});
test.each([
  ["K7X2M9QD", "k7x2m9qd"],
  ["k7x2m9qd", "k7x2m9qd"],
  ["iL0o0000", "11000000"],
])("normaliseRef(%s) maps case and i/l/o", (raw, want) => expect(normaliseRef(raw)).toBe(want));
test.each(["k7x2m9q", "k7x2m9qdd", "k7x2m9q-", "uuuuuuuu", ""])("%s is not a ref", (raw) =>
  expect(normaliseRef(raw)).toBeUndefined(),
);
