import { describe, expect, test } from "vitest";
import { EMAIL_MAX, signUpSchema, USER_NAME_MAX } from "./schemas.ts";

const base = {
  name: "Alice",
  handle: "alice",
  email: "alice@example.com",
  password: "password123",
};
/** A syntactically valid email of exactly `length` characters. */
const emailOf = (length: number) => `${"a".repeat(length - "@example.com".length)}@example.com`;

describe("signUpSchema lengths", () => {
  test("the limits are 80 and 254", () => {
    expect(USER_NAME_MAX).toBe(80);
    expect(EMAIL_MAX).toBe(254);
  });

  test("a name of 80 characters is accepted, 81 is refused with the field message", () => {
    expect(signUpSchema.safeParse({ ...base, name: "n".repeat(80) }).success).toBe(true);
    const r = signUpSchema.safeParse({ ...base, name: "n".repeat(81) });
    expect(r.success).toBe(false);
    expect(r.error?.issues).toEqual([
      expect.objectContaining({
        path: ["name"],
        message: "Keep your name to 80 characters or fewer.",
      }),
    ]);
  });

  test("the name is trimmed before it is measured", () => {
    expect(signUpSchema.safeParse({ ...base, name: `  ${"n".repeat(80)}  ` }).success).toBe(true);
  });

  test("an email of 254 characters is accepted, 255 is refused with the field message", () => {
    const ok = emailOf(254);
    expect(ok).toHaveLength(254);
    expect(signUpSchema.safeParse({ ...base, email: ok }).success).toBe(true);
    const long = emailOf(255);
    expect(long).toHaveLength(255);
    const r = signUpSchema.safeParse({ ...base, email: long });
    expect(r.success).toBe(false);
    expect(r.error?.issues).toEqual([
      expect.objectContaining({
        path: ["email"],
        message: "Keep your email to 254 characters or fewer.",
      }),
    ]);
  });
});
