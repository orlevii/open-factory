import type { ChatEntry, ChatPage } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WsContext, type WsHub } from "@/lib/ws-context";
import { refFor } from "@/test/refs";
import { onChatChanged, refreshChat, useChat } from "./use-chat";

const at = (i: number) => new Date(Date.UTC(2026, 10, 23, 9, 0, i)).toISOString();
const msg = (i: number): ChatEntry => ({
  kind: "message",
  id: `m${i}`,
  from: { kind: "agent", ref: "ada00000" },
  body: `body ${i}`,
  recipients: [{ ref: "0r000000" }],
  urgent: false,
  createdAt: at(i),
  state: "delivered",
});

/** The server: a thread, pages of 50 from the newest back by a cursor that is the count before. */
let thread: ChatEntry[];
let requests: string[];
let gate: Promise<void> | undefined;
let failing = false;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
function pageOf(url: string): ChatPage {
  const before = new URL(url, "http://x").searchParams.get("before");
  const end = before === null ? thread.length : Number(before);
  const start = Math.max(0, end - 50);
  return {
    entries: thread.slice(start, end),
    nextCursor: start > 0 ? String(start) : null,
    newerCursor: null,
    working: null,
  };
}
beforeEach(() => {
  thread = Array.from({ length: 50 }, (_, i) => msg(i + 1));
  requests = [];
  gate = undefined;
  failing = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      if (failing) return new Response("{}", { status: 500 });
      const page = pageOf(url);
      await gate;
      return json(page);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let hub: WsHub = { send: () => true, listen: () => () => {}, status: "open", openCount: 1 };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <WsContext.Provider value={hub}>{children}</WsContext.Provider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useChat(refFor("ada")), { wrapper });
  return {
    qc,
    hook,
    reopen: () => {
      hub = { ...hub, openCount: hub.openCount + 1 };
      hook.rerender();
    },
  };
}
const frame = (qc: QueryClient) =>
  onChatChanged(qc, { type: "chat_changed", agent: refFor("ada") });
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

test("60 entries arriving between frames refetch until they meet the cache", async () => {
  const { qc, hook } = setup();
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(50));
  for (let i = 51; i <= 110; i++) thread.push(msg(i));
  requests = [];
  frame(qc);
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(110));
  expect(requests).toEqual([
    `/api/agents/${refFor("ada")}/chat?`,
    `/api/agents/${refFor("ada")}/chat?before=60`,
  ]);
  expect(hook.result.current.entries.map((e) => (e as { id: string }).id).slice(0, 3)).toEqual([
    "m1",
    "m2",
    "m3",
  ]);
});

test("only frame-driven refreshes add to live; a focus refresh adds nothing", async () => {
  const { qc, hook } = setup();
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(50));
  expect(hook.result.current.live.size).toBe(0);
  thread.push(msg(51));
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(51));
  expect(hook.result.current.live.size).toBe(0);
  thread.push(msg(52));
  frame(qc);
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(52));
  expect([...hook.result.current.live]).toEqual(["m52"]);
});

test("a reopened socket refreshes the newest page and adds nothing to live", async () => {
  const { hook, reopen } = setup();
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(50));
  thread.push(msg(51));
  reopen();
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(51));
  expect(hook.result.current.live.size).toBe(0);
});

test("a frame that arrives while the tab is hidden fades nothing", async () => {
  const { qc, hook } = setup();
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(50));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  thread.push(msg(51));
  frame(qc);
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(51));
  hidden.mockRestore();
  expect(hook.result.current.live.size).toBe(0);
});

test("frames while one is in flight make one trailing refresh", async () => {
  const { qc, hook } = setup();
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(50));
  requests = [];
  let open: () => void = () => {};
  gate = new Promise<void>((r) => {
    open = r;
  });
  frame(qc);
  frame(qc);
  frame(qc);
  await settle();
  expect(requests).toHaveLength(1);
  gate = undefined;
  open();
  await settle();
  expect(requests).toHaveLength(2);
});

test("a frame for a chat nobody has open fetches nothing", async () => {
  const qc = new QueryClient();
  frame(qc);
  await settle();
  expect(requests).toEqual([]);
});

test("refreshChat with no cache loads the thread", async () => {
  const qc = new QueryClient();
  await refreshChat(qc, refFor("ada"), "other");
  expect(requests).toEqual([`/api/agents/${refFor("ada")}/chat?`]);
});

test("loadEarlier prepends older entries and none of them is live", async () => {
  thread = Array.from({ length: 120 }, (_, i) => msg(i + 1));
  const { hook } = setup();
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(50));
  expect(hook.result.current.hasEarlier).toBe(true);
  await act(() => hook.result.current.loadEarlier());
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(100));
  expect(hook.result.current.live.size).toBe(0);
});

test("a failed first load stays an error; frames reject nothing and a later frame still loads it", async () => {
  failing = true;
  const { qc, hook } = setup();
  await waitFor(() => expect(hook.result.current.status).toBe("error"));
  frame(qc);
  frame(qc);
  frame(qc);
  await settle();
  expect(hook.result.current.status).toBe("error");
  failing = false;
  frame(qc);
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(50));
});

test("a gap wider than the cap replaces the cache with the newest pages, leaving no hole", async () => {
  const { qc, hook } = setup();
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(50));
  for (let i = 51; i <= 1150; i++) thread.push(msg(i));
  frame(qc);
  await waitFor(() => expect(hook.result.current.entries).toHaveLength(1050));
  const ids = hook.result.current.entries.map((e) => (e as { id: string }).id);
  expect(ids[0]).toBe("m101");
  expect(ids[1049]).toBe("m1150");
  expect(hook.result.current.hasEarlier).toBe(true);
  expect(hook.result.current.live.size).toBe(0);
});
