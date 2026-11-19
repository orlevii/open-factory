import { vi } from "vitest";

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
