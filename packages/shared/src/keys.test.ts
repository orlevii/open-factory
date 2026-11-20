import { expect, test } from "vitest";
import { formatKey, parseKey } from "./keys.ts";
import { parseTaskKey, taskKey } from "./tasks.ts";

test("keys", () => {
  for (const r of ["S-3", "s-3", "3", " S-3 "]) expect(parseKey("S", r)).toBe(3);
  for (const r of ["T-3", "S-0", "S-", "x", "S-1234567890"]) expect(parseKey("S", r)).toBeNull();
  expect(formatKey("S", 3)).toBe("S-3");
  expect(parseTaskKey("t-42")).toBe(42);
  expect(taskKey(42)).toBe("T-42");
});
