import type { PrincipalItem } from "@open-factory/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "@/lib/query-client";
import { json, mockApi } from "@/test/mock-api";
import type { PrincipalsCache } from "./api";
import { usePrincipal } from "./use-principal";

const person = (ref: string, handle: string): PrincipalItem => ({
  id: `id-${ref}`,
  ref,
  kind: "human",
  handle,
  name: handle,
  state: "live",
  avatar: null,
});
const ALICE = person("aaaaaaa1", "alice");
const BOB = person("bbbbbbb2", "bob");

let frames: FrameRequestCallback[];
const runFrame = () =>
  act(() => {
    for (const f of frames.splice(0)) f(0);
  });

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const api = mockApi({
    "GET /api/principals": () => json({ principals: [ALICE] }),
    "GET /api/principals?": (_b, url) => {
      const refs = new URL(url, "http://x").searchParams.get("refs")?.split(",") ?? [];
      return json({ principals: [ALICE, BOB].filter((p) => refs.includes(p.ref)) });
    },
  });
  const qc = createQueryClient({ queries: { retry: false } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const batchCalls = () => api.calls.filter((c) => c.url.includes("?refs="));
  return { wrapper, batchCalls, qc };
}

test("a ref in the loaded cache is found without a second request", async () => {
  const { wrapper, batchCalls } = setup();
  const { result } = renderHook(() => usePrincipal(ALICE.ref), { wrapper });
  expect(result.current.status).toBe("pending");
  await waitFor(() => expect(result.current).toEqual({ status: "found", principal: ALICE }));
  await runFrame();
  expect(batchCalls()).toHaveLength(0);
});

test("a ref missing from the cache is fetched once and then found", async () => {
  const { wrapper, batchCalls } = setup();
  const { result } = renderHook(() => ({ a: usePrincipal(BOB.ref), b: usePrincipal(BOB.ref) }), {
    wrapper,
  });
  await waitFor(() => expect(frames.length).toBeGreaterThan(0));
  await runFrame();
  await waitFor(() => expect(result.current.a.principal).toEqual(BOB));
  expect(result.current.b.principal).toEqual(BOB);
  expect(batchCalls().map((c) => c.url)).toEqual([`/api/principals?refs=${BOB.ref}`]);
});

test("a ref the server doesn't know becomes unknown, never before the fetch answers", async () => {
  const { wrapper, batchCalls } = setup();
  const { result } = renderHook(() => usePrincipal("ccccccc3"), { wrapper });
  await waitFor(() => expect(frames.length).toBeGreaterThan(0));
  // Cache loaded, batch not flushed yet.
  expect(result.current.status).toBe("pending");
  await runFrame();
  await waitFor(() => expect(result.current.status).toBe("unknown"));
  expect(batchCalls()).toHaveLength(1);
});

test("two refs asked in one frame go out as one request", async () => {
  const { wrapper, batchCalls } = setup();
  const { result } = renderHook(() => ({ a: usePrincipal(BOB.ref), b: usePrincipal("ccccccc3") }), {
    wrapper,
  });
  await waitFor(() => expect(frames.length).toBeGreaterThan(0));
  await runFrame();
  await waitFor(() => expect(result.current.b.status).toBe("unknown"));
  expect(result.current.a.principal).toEqual(BOB);
  expect(batchCalls().map((c) => c.url)).toEqual([`/api/principals?refs=${BOB.ref},ccccccc3`]);
});

test("a ref typed in capitals is found under its canonical ref", async () => {
  const { wrapper } = setup();
  const { result } = renderHook(() => usePrincipal(BOB.ref.toUpperCase()), { wrapper });
  await waitFor(() => expect(frames.length).toBeGreaterThan(0));
  await runFrame();
  await waitFor(() => expect(result.current.principal).toEqual(BOB));
});

test("more refs than one request may carry are all answered, none stuck pending", async () => {
  const { wrapper, batchCalls } = setup();
  const refs = Array.from({ length: 101 }, (_, i) => `dddd${String(i).padStart(4, "0")}`);
  const { result } = renderHook(() => refs.map((r) => usePrincipal(r).status), { wrapper });
  await waitFor(() => expect(frames.length).toBeGreaterThan(0));
  await runFrame();
  await waitFor(() => expect(result.current.every((s) => s === "unknown")).toBe(true));
  expect(batchCalls()).toHaveLength(2);
});

test("a ref learned to be nobody stays unknown after the list refetches", async () => {
  const { wrapper, qc } = setup();
  const { result } = renderHook(() => usePrincipal("ccccccc3"), { wrapper });
  await waitFor(() => expect(frames.length).toBeGreaterThan(0));
  await runFrame();
  await waitFor(() => expect(result.current.status).toBe("unknown"));
  await act(() => qc.refetchQueries({ queryKey: ["principals"] }));
  await waitFor(() => expect(result.current.status).toBe("unknown"));
  // Rendered state lags the cache by a tick, so check the cache itself too.
  expect(qc.getQueryData<PrincipalsCache>(["principals"])?.unknown.has("ccccccc3")).toBe(true);
});
