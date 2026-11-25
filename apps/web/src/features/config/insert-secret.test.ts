import { expect, test } from "vitest";
import { insertReference } from "./insert-secret";

const ref = `\${GH_TOKEN}`;

test("inserts at the caret, replacing a selection, and puts the caret after it", () => {
  expect(insertReference("Bearer !", "GH_TOKEN", { start: 7, end: 7 })).toEqual({
    value: `Bearer ${ref}!`,
    at: 7 + ref.length,
  });
  expect(insertReference("a-XX-b", "GH_TOKEN", { start: 2, end: 4 }).value).toBe(`a-${ref}-b`);
});

test("with no saved caret it appends; a stale caret past the end is clamped", () => {
  expect(insertReference("x", "GH_TOKEN", null)).toEqual({ value: `x${ref}`, at: 1 + ref.length });
  expect(insertReference("x", "GH_TOKEN", { start: 9, end: 12 }).value).toBe(`x${ref}`);
});
