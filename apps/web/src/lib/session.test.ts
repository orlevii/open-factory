import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { sessionQueryOptions } from "./session";

const me = { id: "u1", email: "or@x.io", name: "Or", handle: "or", ref: "abcd2345" };

const fetchSession = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } }).fetchQuery(
    sessionQueryOptions,
  );

const answer = (status: number, body?: unknown) =>
  vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status }));

afterEach(() => vi.restoreAllMocks());

test("the session query reads the signed-in user from /api/me", async () => {
  const fetch = answer(200, me);
  await expect(fetchSession()).resolves.toEqual({ user: me });
  expect(String(fetch.mock.calls[0]?.[0])).toBe("/api/me");
});

test("a 401 is signed out", async () => {
  answer(401, { error: { code: "unauthorized", message: "Not signed in" } });
  await expect(fetchSession()).resolves.toBeNull();
});

test("throws on a server error instead of reporting 'no session'", async () => {
  answer(500, { error: { code: "internal", message: "boom" } });
  await expect(fetchSession()).rejects.toThrow();
});
