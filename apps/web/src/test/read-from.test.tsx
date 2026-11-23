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
const UNREAD = { count: 2, byAgent: { dev: 2 } };
let unread: { count: number; byAgent: Record<string, number> };
let unreadFetches: number;
/** false: newer unread messages keep arriving, so a call never leaves the server with zero unread */
let clears: boolean;
let postStatus: number;
let postGate: Promise<void> | undefined;

beforeEach(() => {
  posts = [];
  unread = UNREAD;
  unreadFetches = 0;
  clears = true;
  postStatus = 200;
  postGate = undefined;
  resetSeq();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/inbox/read-from/")) {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        await postGate;
        if (postStatus === 200 && clears) unread = { count: 0, byAgent: {} }; // the server now has them read
        return postStatus === 200
          ? json({ marked: 2, readAt: NEWEST })
          : json({ error: { code: "boom", message: "x" } }, postStatus);
      }
      if (url === "/api/inbox/unread-count") {
        unreadFetches++;
        return json(unread);
      }
      if (url === "/api/agents") return json([agentSummary()]);
      if (url === "/api/agents/dev") return json(detail());
      if (url === "/api/agents/ada") return json(detail({ slug: "ada" }));
      if (url.startsWith("/api/agents/ada/events?"))
        return json({ events: [], hasMore: { before: false, after: false } });
      if (url.startsWith("/api/agents/dev/events?")) return json(conversation());
      if (url.startsWith("/api/inbox")) return json({ chats: [], items: [], nextCursor: null });
      return json({ error: { code: "not_found", message: url } }, 404);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

const FAKE: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
} as const;
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
  renderApp("/agents/dev/session", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]?.url).toBe("/api/inbox/read-from/dev");
  expect(posts[0]?.body.upTo).toBe(NEWEST);
  await new Promise((r) => setTimeout(r, 50));
  expect(posts).toHaveLength(1);
});

test("hidden document: no call until visible", async () => {
  setVisibility("hidden");
  renderApp("/agents/dev/session", alice);
  await waitFor(() => expect(unreadFetches).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 50));
  expect(posts).toHaveLength(0);
  setVisibility("visible");
  await waitFor(() => expect(posts).toHaveLength(1));
});

test("re-runs when the newest event advances while the count stays > 0; at most one in flight, at most 1/s", async () => {
  clears = false;
  let release = () => {};
  postGate = new Promise<void>((r) => {
    release = r;
  });
  const { queryClient } = renderApp("/agents/dev/session", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  // The count is still > 0 (the server hasn't confirmed); newer events arrive while one is in flight.
  vi.useFakeTimers(FAKE);
  liveEvent("2026-11-18T10:00:01.000Z");
  liveEvent("2026-11-18T10:00:02.000Z");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100); // the session's frame batching
  });
  queryClient.setQueryData(["inbox-unread"], UNREAD);
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
  const { queryClient } = renderApp("/agents/dev/session", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  await waitFor(() => expect(unreadFetches).toBeGreaterThanOrEqual(2));
  await waitFor(() =>
    expect(queryClient.getQueryData(["inbox-unread"])).toEqual({ count: 2, byAgent: { dev: 2 } }),
  );
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

test("a persistent failure is not retried until a newer event arrives", async () => {
  postStatus = 500;
  postGate = new Promise((r) => setTimeout(r, 100)); // the optimistic zero renders before the failure lands
  renderApp("/agents/dev/session", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  await waitFor(() => expect(unreadFetches).toBeGreaterThanOrEqual(2)); // the refetch restored the count
  await new Promise((r) => setTimeout(r, 2300)); // past two throttle windows
  expect(posts).toHaveLength(1);
  liveEvent("2026-11-18T10:00:09.000Z");
  await waitFor(() => expect(posts).toHaveLength(2), { timeout: 3000 });
  expect(posts[1]?.body.upTo).toBe("2026-11-18T10:00:09.000Z");
  await new Promise((r) => setTimeout(r, 1300));
  expect(posts).toHaveLength(2);
}, 10000);

test("a failure is retried once the tab becomes visible again", async () => {
  postStatus = 500;
  postGate = new Promise((r) => setTimeout(r, 100));
  renderApp("/agents/dev/session", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  await waitFor(() => expect(unreadFetches).toBeGreaterThanOrEqual(2));
  postStatus = 200;
  setVisibility("hidden");
  setVisibility("visible");
  await waitFor(() => expect(posts).toHaveLength(2));
});

test("while a call is in flight no second call goes out, however long it takes", async () => {
  clears = false;
  let release = () => {};
  postGate = new Promise<void>((r) => {
    release = r;
  });
  const { queryClient } = renderApp("/agents/dev/session", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  vi.useFakeTimers(FAKE);
  queryClient.setQueryData(["inbox-unread"], UNREAD); // still unread: the effect wants another call
  liveEvent("2026-11-18T10:00:05.000Z");
  await advance(3000);
  expect(posts).toHaveLength(1);
  postGate = undefined;
  await act(async () => {
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
  await advance(1100);
  expect(posts).toHaveLength(2);
});

/** A trailing call waiting on the throttle: the first call is done, the count is > 0 again. */
async function withTrailingCall() {
  const r = renderApp("/agents/dev/session", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  // The optimistic zero has rendered (the effect saw no unread) before the count comes back.
  await waitFor(() =>
    expect(r.queryClient.getQueryData(["inbox-unread"])).toMatchObject({ count: 0 }),
  );
  await act(async () => {});
  vi.useFakeTimers(FAKE);
  // A message newer than the last call arrives: the count is > 0 again and there is something to read.
  liveEvent("2026-11-18T10:00:30.000Z");
  act(() => r.queryClient.setQueryData(["inbox-unread"], UNREAD));
  await advance(150);
  expect(posts).toHaveLength(1); // waiting on the throttle
  return r;
}

test("a trailing call due while the tab is hidden waits until it is visible", async () => {
  await withTrailingCall();
  setVisibility("hidden");
  await advance(3000);
  expect(posts).toHaveLength(1);
  setVisibility("visible");
  await advance(50);
  expect(posts).toHaveLength(2);
});

test("the trailing call is cancelled on unmount", async () => {
  const { unmount } = await withTrailingCall();
  unmount();
  await advance(3000);
  expect(posts).toHaveLength(1);
});

test("the trailing call is cancelled when the session changes", async () => {
  const { router } = await withTrailingCall();
  await act(async () => {
    await router.navigate({ to: "/agents/$slug/session", params: { slug: "ada" } });
  });
  await advance(3000);
  expect(posts.filter((p) => p.url.endsWith("/dev"))).toHaveLength(1);
});

test("a hover preload of /agents/ada never calls read-from", async () => {
  const { router } = renderApp("/", alice);
  await router.preloadRoute({ to: "/agents/$slug/session", params: { slug: "ada" } });
  await new Promise((r) => setTimeout(r, 50));
  expect(posts).toHaveLength(0);
});

test("the count rising again with nothing newer is no reason to post (an Undo of Mark all read sticks)", async () => {
  const r = renderApp("/agents/dev/session", alice);
  await waitFor(() => expect(posts).toHaveLength(1));
  await waitFor(() =>
    expect(r.queryClient.getQueryData(["inbox-unread"])).toMatchObject({ count: 0 }),
  );
  act(() => r.queryClient.setQueryData(["inbox-unread"], UNREAD));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(posts).toHaveLength(1);
});
