import type { PrincipalItem } from "@open-factory/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "@/lib/query-client";
import { json, mockApi } from "@/test/mock-api";
import { usePlainTags } from "./plain-tags";

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
  mockApi({
    "GET /api/principals": () => json({ principals: [ALICE] }),
    "GET /api/principals?": (_b, url) => {
      const refs = new URL(url, "http://x").searchParams.get("refs")?.split(",") ?? [];
      return json({ principals: [ALICE, BOB].filter((p) => refs.includes(p.ref)) });
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup(text: string) {
  const qc = createQueryClient({ queries: { retry: false } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => usePlainTags(text), { wrapper });
}

test("an unfetched ref reads @… then its handle once the batch answers, never @unknown", async () => {
  const seen: string[] = [];
  const { result } = setup("hi <@bbbbbbb2> and <@aaaaaaa1>");
  seen.push(result.current);
  expect(result.current).toBe("hi @… and @…");
  await waitFor(() => expect(result.current).toBe("hi @… and @alice"));
  await waitFor(() => expect(frames.length).toBeGreaterThan(0));
  await runFrame();
  await waitFor(() => expect(result.current).toBe("hi @bob and @alice"));
  expect(seen.join()).not.toContain("unknown");
});

test("a ref the server confirms is nobody reads @unknown", async () => {
  const { result } = setup("<@ccccccc3>");
  await waitFor(() => expect(frames.length).toBeGreaterThan(0));
  await runFrame();
  await waitFor(() => expect(result.current).toBe("@unknown"));
});
