import { ApiError } from "@open-factory/shared";
import { expect, it } from "vitest";
import { isRetryableWaitError } from "./api";

it("retries a network error, a bare HTTP status and the server's own unhandled 5xx", () => {
  expect(isRetryableWaitError(new TypeError("Failed to fetch"))).toBe(true);
  expect(isRetryableWaitError(new ApiError(504, "http_504", "Gateway Timeout"))).toBe(true);
  expect(isRetryableWaitError(new ApiError(502, "http_502", "Bad Gateway"))).toBe(true);
  expect(isRetryableWaitError(new ApiError(500, "internal_error", "Internal error"))).toBe(true);
});

it("never retries a coded business error", () => {
  for (const [status, code] of [
    [502, "sign_in_failed"],
    [502, "claude_unreachable"],
    [422, "sign_in_code_rejected"],
    [409, "sign_in_state"],
    [404, "sign_in_not_found"],
    [410, "sign_in_expired"],
  ] as const)
    expect(isRetryableWaitError(new ApiError(status, code, "x")), code).toBe(false);
  expect(isRetryableWaitError(new Error("boom"))).toBe(false);
});
