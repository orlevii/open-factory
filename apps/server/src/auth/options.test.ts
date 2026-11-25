import { describe, expect, test } from "vitest";
import { inputLengthError } from "./options.ts";

const long = (n: number) => "x".repeat(n);
const emailOf = (n: number) => `${"a".repeat(n - "@example.com".length)}@example.com`;

describe("inputLengthError", () => {
  test.each(["/sign-up/email", "/update-user"])(
    "%s refuses a name over 80, padding included",
    (path) => {
      expect(inputLengthError(path, { name: long(81) })).toEqual({
        code: "NAME_TOO_LONG",
        message: "Use 80 characters or fewer.",
      });
      expect(inputLengthError(path, { name: long(80) })).toBeNull();
      expect(inputLengthError(path, { name: `  ${long(76)}  ` })).toBeNull();
      expect(inputLengthError(path, { name: long(80) + " ".repeat(1000) })?.code).toBe(
        "NAME_TOO_LONG",
      );
    },
  );

  test("sign-up refuses an email over 254, accepts 254", () => {
    expect(inputLengthError("/sign-up/email", { name: "A", email: emailOf(255) })).toEqual({
      code: "EMAIL_TOO_LONG",
      message: "Use 254 characters or fewer.",
    });
    expect(inputLengthError("/sign-up/email", { name: "A", email: emailOf(254) })).toBeNull();
  });

  test("update-user doesn't check email (it can't change it here)", () => {
    expect(inputLengthError("/update-user", { email: emailOf(255) })).toBeNull();
  });

  test("a body without a name, or with a non-string one, passes (other validation owns it)", () => {
    expect(inputLengthError("/update-user", { handle: "x" })).toBeNull();
    expect(inputLengthError("/update-user", { name: 5 })).toBeNull();
    expect(inputLengthError("/update-user", undefined)).toBeNull();
    expect(inputLengthError("/update-user", null)).toBeNull();
  });

  test("other paths are not checked", () => {
    expect(inputLengthError("/sign-in/email", { email: emailOf(300), name: long(200) })).toBeNull();
  });
});
