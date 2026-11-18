import { describe, expect, test } from "vitest";
import { handleSchema, RESERVED_HANDLES } from "./handle.ts";

describe("handleSchema", () => {
  test.each(["or", "or-levi", "a1", "x".repeat(32), "9lives"])("accepts %s", (h) => {
    expect(handleSchema.safeParse(h).success).toBe(true);
  });
  test.each(["a", "x".repeat(33), "Or", "-or", "or-", "or_levi", "or levi", "", "élan"])(
    "rejects %s",
    (h) => expect(handleSchema.safeParse(h).success).toBe(false),
  );
  test("rejects reserved handles", () => {
    for (const h of RESERVED_HANDLES) expect(handleSchema.safeParse(h).success).toBe(false);
    expect(RESERVED_HANDLES).toEqual(["humans", "me", "scheduler"]);
  });
  test("is synchronous (better-auth rejects async validators)", () => {
    expect(() => handleSchema.parse("ok-handle")).not.toThrow();
  });
});
