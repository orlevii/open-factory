import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import { sessionQueryOptions } from "./session";

const getSession = vi.hoisted(() => vi.fn());
vi.mock("./auth-client", () => ({ authClient: { getSession } }));

const fetchSession = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } }).fetchQuery(
    sessionQueryOptions,
  );

beforeEach(() => getSession.mockReset());

test("returns the session when signed in", async () => {
  getSession.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  await expect(fetchSession()).resolves.toEqual({ user: { id: "u1" } });
});

test("returns null when there is definitely no session (null body or 401)", async () => {
  getSession.mockResolvedValue({ data: null, error: null });
  await expect(fetchSession()).resolves.toBeNull();
  getSession.mockResolvedValue({ data: null, error: { status: 401, message: "Unauthorized" } });
  await expect(fetchSession()).resolves.toBeNull();
});

test("throws on a server error instead of reporting 'no session'", async () => {
  getSession.mockResolvedValue({
    data: null,
    error: { status: 500, statusText: "Internal Server Error", message: "boom" },
  });
  await expect(fetchSession()).rejects.toThrow();
});
