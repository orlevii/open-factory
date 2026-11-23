import { describe, expect, test } from "vitest";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { authErrorCode, mapAuthError, mapAuthFailure } from "./auth-error";

describe("mapAuthError", () => {
  test.each([
    ["HANDLE_TAKEN", "handle", "That handle is already taken."],
    ["USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", "email", "That email already has an account."],
    ["NAME_TOO_LONG", "name", "Use 80 characters or fewer."],
    ["EMAIL_TOO_LONG", "email", "Use 254 characters or fewer."],
    ["PASSWORD_TOO_SHORT", "password", "Use at least 8 characters."],
  ] as const)("%s maps to the %s field", (code, field, message) => {
    expect(mapAuthError(code, "server text")).toEqual({ field, message });
  });

  test("VALIDATION_ERROR maps to the handle field with the server message", () => {
    expect(mapAuthError("VALIDATION_ERROR", "Handle is reserved")).toEqual({
      field: "handle",
      message: "Handle is reserved",
    });
  });

  test("wrong credentials are a form-level message", () => {
    expect(mapAuthError("INVALID_EMAIL_OR_PASSWORD", "x")).toEqual({
      message: "Wrong email or password.",
    });
  });

  test("an unknown code becomes a form-level message with no field", () => {
    expect(mapAuthError("FAILED_TO_CREATE_USER", "Failed to create user")).toEqual({
      message: "Failed to create user",
    });
    expect(mapAuthError(undefined, "")).toEqual({ message: "Something went wrong. Try again." });
  });
});

describe("mapAuthFailure", () => {
  test("a rejected call (fetch TypeError: server unreachable) is the network message", () => {
    expect(mapAuthFailure({ thrown: new TypeError("Failed to fetch") })).toEqual({
      message: "Couldn't reach the server. Try again.",
    });
  });

  test.each([0, 502, 503, 504, undefined])(
    "an error with no code and status %s is the network message",
    (status) => {
      expect(mapAuthFailure({ error: { status, message: "" } })).toEqual({
        message: FORM_MSG.unreachable,
      });
    },
  );

  test("a coded error still maps through mapAuthError", () => {
    expect(mapAuthFailure({ error: { code: "HANDLE_TAKEN", status: 422 } })).toEqual({
      field: "handle",
      message: "That handle is already taken.",
    });
    expect(mapAuthFailure({ error: { status: 500, message: "Internal" } })).toEqual({
      message: "Internal",
    });
  });

  test("the sign-up gate's ApiError envelope (nested under error) maps by its code", () => {
    // better-fetch spreads the parsed body `{ error: { code, message } }` next to the status.
    const error = {
      error: { code: "invite_invalid", message: "Invite invalid" },
      status: 403,
      statusText: "Forbidden",
    };
    expect(mapAuthFailure({ error })).toEqual({ message: FORM_MSG.inviteInvalid });
    expect(authErrorCode(error)).toBe("invite_invalid");
    expect(authErrorCode({ code: "USER_DISABLED", status: 403 })).toBe("USER_DISABLED");
    expect(authErrorCode({ status: 500 })).toBeUndefined();
  });
});

test("every message mapAuthError can return is at most 40 characters (spec §8)", () => {
  const codes = [
    "HANDLE_TAKEN",
    "NAME_TOO_LONG",
    "EMAIL_TOO_LONG",
    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
    "PASSWORD_TOO_SHORT",
    "INVALID_EMAIL_OR_PASSWORD",
    "invite_invalid",
    "invite_required",
    "USER_DISABLED",
    "NETWORK_ERROR",
    undefined,
  ];
  for (const c of codes) expect(mapAuthError(c, "").message.length, c).toBeLessThanOrEqual(40);
});
