import { describe, expect, test } from "vitest";
import { mapAuthError, mapAuthFailure, NETWORK_MESSAGE } from "./auth-error";

describe("mapAuthError", () => {
  test.each([
    ["HANDLE_TAKEN", "handle", "That handle is already taken."],
    [
      "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      "email",
      "An account with this email already exists.",
    ],
    ["PASSWORD_TOO_SHORT", "password", "Password must be at least 8 characters."],
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
});
