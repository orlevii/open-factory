import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "@/lib/query-client";
import { json, mockApi } from "@/test/mock-api";
import { hostQueryOptions } from "./host";

afterEach(() => vi.unstubAllGlobals());

test("host info is fetched once and never goes stale", async () => {
  const api = mockApi({
    "GET /api/host": () => json({ platform: "darwin", hostname: "mac", home: "/Users/or" }),
  });
  const qc = createQueryClient(); // production defaults (lib/query-client.ts, pr76 R1)
  await qc.prefetchQuery(hostQueryOptions);
  await qc.prefetchQuery(hostQueryOptions);
  expect(api.calls.filter((c) => c.url === "/api/host")).toHaveLength(1);
  expect(qc.getQueryData(hostQueryOptions.queryKey)).toEqual({
    platform: "darwin",
    hostname: "mac",
    home: "/Users/or",
  });
});
