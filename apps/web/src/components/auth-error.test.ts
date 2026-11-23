import { describe, expect, test } from "vitest";
import {
  authErrorCode,
  INVITE_INVALID_MESSAGE,
  mapAuthError,
  mapAuthFailure,
  NETWORK_MESSAGE,
} from "./auth-error";

describe("mapAuthError", () => {
  test.each([
    ["HANDLE_TAKEN", "handle", "That handle is already taken."],
    [
      "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      "email",
      "An account with this email already exists.",
    ],
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
      message: NETWORK_MESSAGE,
    });
  });

  test.each([0, 502, 503, 504, undefined])(
    "an error with no code and status %s is the network message",
    (status) => {
      expect(mapAuthFailure({ error: { status, message: "" } })).toEqual({
        message: NETWORK_MESSAGE,
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
    expect(mapAuthFailure({ error })).toEqual({ message: INVITE_INVALID_MESSAGE });
    expect(authErrorCode(error)).toBe("invite_invalid");
    expect(authErrorCode({ code: "USER_DISABLED", status: 403 })).toBe("USER_DISABLED");
    expect(authErrorCode({ status: 500 })).toBeUndefined();
  });
});
