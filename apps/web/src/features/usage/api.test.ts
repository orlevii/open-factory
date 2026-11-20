import { expect, test } from "vitest";
import { agentsUsageQuery } from "./api";

test("the tree's rolling window sends window=rolling and no days", async () => {
  const urls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ agents: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    const ctx = { queryKey: [], signal: new AbortController().signal, meta: undefined } as never;
    await (agentsUsageQuery("rolling7").queryFn as (c: never) => Promise<unknown>)(ctx);
    await (agentsUsageQuery(30).queryFn as (c: never) => Promise<unknown>)(ctx);
  } finally {
    globalThis.fetch = orig;
  }
  expect(urls).toEqual(["/api/usage/agents?window=rolling", "/api/usage/agents?days=30"]);
  expect(agentsUsageQuery(7).queryKey[0]).toBe("usage");
});
