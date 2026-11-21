import type { ServerMessage } from "@open-factory/shared";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary, conversation, detail, resetSeq, se } from "@/test/session-fixtures";

const ws = vi.hoisted(() => ({ onMessage: undefined as undefined | ((m: ServerMessage) => void) }));
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void; onOpen?: () => void }) => {
    ws.onMessage = o.onMessage;
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const NEWEST = "2026-11-18T10:00:00.000Z";
let posts: { url: string; body: { upTo: string } }[];
let unread: { count: number; byAgent: Record<string, number> };
let unreadFetches: number;
let postStatus: number;
let postGate: Promise<void> | undefined;

beforeEach(() => {
  posts = [];
  unread = { count: 2, byAgent: { dev: 2 } };
  unreadFetches = 0;
  postStatus = 200;
  postGate = undefined;
  resetSeq();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/inbox/read-from/")) {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        await postGate;
        return postStatus === 200
          ? json({ marked: 2 })
          : json({ error: { code: "boom", message: "x" } }, postStatus);
      }
      if (url === "/api/inbox/unread-count") {
        unreadFetches++;
        return json(unread);
      }
      if (url === "/api/agents") return json([agentSummary()]);
      if (url === "/api/agents/dev") return json(detail());
      if (url.startsWith("/api/agents/dev/events?")) return json(conversation());
      if (url.startsWith("/api/inbox")) return json({ items: [], nextCursor: null });
      return json({ error: { code: "not_found", message: url } }, 404);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

const setVisibility = (v: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};
const liveEvent = (at: string) =>
  act(() =>
    ws.onMessage?.({
      type: "session_event",
      agent: "dev",
      event: { ...se({ type: "assistant_text", text: "more" }), at },
    }),
  );

test("visible session with unread messages calls read-from once with upTo = newest event time", async () => {
  renderApp("/agents/dev", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]?.url).toBe("/api/inbox/read-from/dev");
  expect(Date.parse(posts[0]?.body.upTo ?? "")).toBeGreaterThanOrEqual(Date.parse(NEWEST));
  await new Promise((r) => setTimeout(r, 50));
  expect(posts).toHaveLength(1);
});

test("hidden document: no call until visible", async () => {
  setVisibility("hidden");
  renderApp("/agents/dev", alice);
  await waitFor(() => expect(unreadFetches).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 50));
  expect(posts).toHaveLength(0);
  setVisibility("visible");
  await waitFor(() => expect(posts).toHaveLength(1));
});

test("re-runs when the newest event advances while the count stays > 0; at most one in flight, at most 1/s", async () => {
  let release = () => {};
  postGate = new Promise<void>((r) => {
    release = r;
  });
  const { queryClient } = renderApp("/agents/dev", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  // The count is still > 0 (the server hasn't confirmed); newer events arrive while one is in flight.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  liveEvent("2026-11-18T10:00:01.000Z");
  liveEvent("2026-11-18T10:00:02.000Z");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100); // the session's frame batching
  });
  queryClient.setQueryData(["inbox-unread"], unread);
  expect(posts).toHaveLength(1); // in flight: nothing else goes out
  postGate = undefined;
  await act(async () => {
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(posts).toHaveLength(1); // throttled: under a second since the last call
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(posts).toHaveLength(2);
  expect(posts[1]?.body.upTo).toBe("2026-11-18T10:00:02.000Z");
});

test("a failed call refetches the unread count and the inbox instead of leaving the optimistic state", async () => {
  postStatus = 500;
  const { queryClient } = renderApp("/agents/dev", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  await waitFor(() => expect(unreadFetches).toBeGreaterThanOrEqual(2));
  await waitFor(() =>
    expect(queryClient.getQueryData(["inbox-unread"])).toEqual({ count: 2, byAgent: { dev: 2 } }),
  );
});

test("a hover preload of /agents/ada never calls read-from", async () => {
  const { router } = renderApp("/", alice);
  await router.preloadRoute({ to: "/agents/$slug", params: { slug: "ada" } });
  await new Promise((r) => setTimeout(r, 50));
  expect(posts).toHaveLength(0);
});
