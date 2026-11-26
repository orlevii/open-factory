import { describe, expect, test } from "vitest";
import { handleSchema } from "./handle.ts";

describe("handleSchema", () => {
  test.each(["or", "or-levi", "a1", "9lives"])("accepts %s", (h) => {
    expect(handleSchema.safeParse(h).success).toBe(true);
  });
  test.each(["a", "Or", "-or", "or-", "or_levi", "or levi", "", "élan"])("rejects %s", (h) =>
    expect(handleSchema.safeParse(h).success).toBe(false),
  );
  test.each(["unknown", "factory", "me"])("%s is refused as a handle", (h) =>
    expect(handleSchema.safeParse(h).success).toBe(false),
  );
  test("a 40-char handle is accepted and a 41-char one refused", () => {
    expect(handleSchema.safeParse(`a${"b".repeat(39)}`).success).toBe(true);
    expect(handleSchema.safeParse(`a${"b".repeat(40)}`).success).toBe(false);
  });
  test("is synchronous (better-auth rejects async validators)", () => {
    expect(() => handleSchema.parse("ok-handle")).not.toThrow();
  });
});
