import { vi } from "vitest";
import type { z } from "zod";

export const json = (data: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
export type Handler = (body: unknown, url: string) => Response | Promise<Response>;
export interface MockApi {
  calls: { method: string; url: string; body: unknown }[];
  on(key: string, h: Handler): void;
}

/** Keys are "METHOD /path" (exact) or "METHOD /path?" (prefix, longest wins). Unknown → 404. */
export function mockApi(routes: Record<string, Handler>): MockApi {
  const table = { ...routes };
  const api: MockApi = {
    calls: [],
    on: (k, h) => {
      table[k] = h;
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      api.calls.push({ method, url, body });
      const key = Object.keys(table)
        .filter((k) => {
          const [m, p = ""] = k.split(" ");
          return m === method && (url === p || (p.endsWith("?") && url.startsWith(p)));
        })
        .sort((a, b) => b.length - a.length)[0];
      const handler = key ? table[key] : undefined;
      return handler
        ? handler(body, url)
        : json({ error: { code: "not_found", message: url } }, 404);
    }),
  );
  return api;
}

/** A URL's query as Fastify parses it: a repeated key becomes an array. */
function queryObject(url: string): Record<string, string | string[]> {
  const q = new URL(url, "http://x").searchParams;
  const out: Record<string, string | string[]> = {};
  for (const k of new Set(q.keys())) {
    const all = q.getAll(k);
    out[k] = all.length === 1 ? (all[0] as string) : all;
  }
  return out;
}

/** Answers 400 as the server does when the request's JSON body fails the route's schema (the real
 *  one, from `@open-factory/shared`). */
export const validBody =
  (schema: z.ZodType, h: Handler): Handler =>
  (body, url) => {
    const r = schema.safeParse(body);
    return r.success
      ? h(body, url)
      : json({ error: { code: "validation_error", message: r.error.message } }, 400);
  };

/** Answers 400 as the server does when the request's query fails the route's schema (the real one,
 *  from `@open-factory/shared`), so a test cannot pass with a URL the server would refuse. */
export const validQuery =
  (schema: z.ZodType, h: Handler): Handler =>
  (body, url) => {
    const r = schema.safeParse(queryObject(url));
    return r.success
      ? h(body, url)
      : json({ error: { code: "validation_error", message: r.error.message } }, 400);
  };
