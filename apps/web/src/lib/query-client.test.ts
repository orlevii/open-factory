import { ApiError } from "@open-factory/shared";
import { expect, test } from "vitest";
import { z } from "zod";
import { createQueryClient, shouldRetry } from "./query-client";

const zodError = (() => {
  try {
    z.string().parse(1);
  } catch (e) {
    return e;
  }
})();

test.each([
  ["404", new ApiError(404, "not_found", "x"), false],
  ["400", new ApiError(400, "validation_error", "x"), false],
  ["ZodError", zodError, false],
  ["500", new ApiError(500, "internal_error", "x"), true],
  ["408", new ApiError(408, "http_408", "x"), true],
  ["429", new ApiError(429, "http_429", "x"), true],
  ["TypeError", new TypeError("Failed to fetch"), true],
])("%s retries: %s", (_n, err, retries) => {
  expect(shouldRetry(0, err)).toBe(retries);
});

test("retries stop after three", () => {
  const e = new TypeError("Failed to fetch");
  expect([0, 1, 2, 3].map((n) => shouldRetry(n, e))).toEqual([true, true, true, false]);
});

test("production defaults, overridable for tests", () => {
  const qc = createQueryClient();
  expect(qc.getDefaultOptions().queries?.staleTime).toBe(30_000);
  expect(qc.getDefaultOptions().queries?.retry).toBe(shouldRetry);
  const t = createQueryClient({ queries: { retry: false } });
  expect(t.getDefaultOptions().queries?.retry).toBe(false);
  expect(t.getDefaultOptions().queries?.staleTime).toBe(30_000);
});
