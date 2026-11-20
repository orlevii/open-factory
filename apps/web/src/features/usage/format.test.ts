import { expect, test } from "vitest";
import { formatTokens } from "@/features/session/format";
import {
  formatCost,
  formatCostEst,
  formatDayShort,
  niceMax,
  parseDay,
  RATE_LIMIT_WINDOW,
} from "./format";

test("formatCost", () => {
  expect(formatCost(0.004, 1)).toBe("<$0.01");
  expect(formatCost(0, 3)).toBe("$0.00");
  expect(formatCost(0, 0)).toBe("—");
  expect(formatCost(12.345, 1)).toBe("$12.35");
  expect(formatCost(1234.5, 1)).toBe("$1,235");
});

test("formatCostEst adds the suffix except on a dash", () => {
  expect(formatCostEst(12.345, 1)).toBe("$12.35 est.");
  expect(formatCostEst(0, 0)).toBe("—");
});

test("formatTokens gains M", () => {
  expect(formatTokens(1_234_567)).toBe("1.2M");
  expect(formatTokens(123_456)).toBe("123k");
});

test("days are parsed and shown without a zone shift", () => {
  expect(parseDay("2026-11-20")).toEqual({ y: 2026, m: 11, d: 20 });
  const wd = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(
    Date.UTC(2026, 10, 20),
  );
  expect(formatDayShort("2026-11-20")).toBe(`${wd} 20 Nov`);
});

test("niceMax rounds up to 1/2/5 x 10^n", () => {
  expect(niceMax(3.21)).toBe(5);
  expect(niceMax(12)).toBe(20);
  expect(niceMax(5)).toBe(5);
  expect(niceMax(0.07)).toBe(0.1);
  expect(niceMax(0)).toBe(1);
});

test("rate limit windows", () => {
  expect(RATE_LIMIT_WINDOW).toEqual({ five_hour: "5-hour", seven_day: "7-day" });
});

test("the tree's rolling window sends window=rolling and no days", async () => {
  const { agentsUsageQuery } = await import("./api");
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
