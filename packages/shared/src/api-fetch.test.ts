import { expect, test, vi } from "vitest";
import { z } from "zod";
import { ApiError, apiFetch } from "./api-fetch.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("parses a 2xx body with the schema and sends bearer + json body", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => json(200, { ok: true }));
  const out = await apiFetch("/api/x", {
    baseUrl: "http://h:1",
    token: "t",
    method: "POST",
    body: { a: 1 },
    schema: z.object({ ok: z.boolean() }),
    fetchImpl,
  });
  expect(out).toEqual({ ok: true });
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://h:1/api/x");
  const headers = new Headers(init.headers);
  expect(headers.get("authorization")).toBe("Bearer t");
  expect(headers.get("content-type")).toBe("application/json");
  expect(init.body).toBe('{"a":1}');
});

test("turns factory error bodies into ApiError", async () => {
  const fetchImpl = vi.fn(async () =>
    json(404, { error: { code: "not_found", message: "Not found" } }),
  );
  const err = await apiFetch("/api/x", { schema: z.any(), fetchImpl }).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 404, code: "not_found", message: "Not found" });
});

test("turns better-auth error bodies into ApiError", async () => {
  const fetchImpl = vi.fn(async () =>
    json(422, { code: "HANDLE_TAKEN", message: "Handle is taken" }),
  );
  const err = await apiFetch("/api/auth/sign-up/email", { schema: z.any(), fetchImpl }).catch(
    (e) => e,
  );
  expect(err).toMatchObject({ status: 422, code: "HANDLE_TAKEN" });
});

test("non-json errors get code http_<status>", async () => {
  const fetchImpl = vi.fn(async () => new Response("boom", { status: 502 }));
  const err = await apiFetch("/api/x", { schema: z.any(), fetchImpl }).catch((e) => e);
  expect(err).toMatchObject({ status: 502, code: "http_502" });
});

test("ApiError keeps the whole error object as body", async () => {
  const fetchImpl = vi.fn(async () =>
    json(409, { error: { code: "changed_on_disk", message: "Changed", currentHash: "abc" } }),
  );
  const err = await apiFetch("/api/x", { schema: z.any(), fetchImpl }).catch((e) => e);
  expect(err.body).toMatchObject({ code: "changed_on_disk", currentHash: "abc" });
});
