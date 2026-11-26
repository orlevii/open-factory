import { act, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readViewPosition, writeViewPosition } from "@/features/agents/view-memory";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary, conversation, detail, se } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({
  frame: (_m: unknown) => {},
  open: () => {},
}));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: {
    onStatus?: (s: string) => void;
    onOpen?: () => void;
    onMessage?: (m: unknown) => void;
  }) => {
    ws.frame = (m) => o.onMessage?.(m);
    ws.open = () => o.onOpen?.();
    setTimeout(() => {
      o.onStatus?.("open");
      o.onOpen?.();
    }, 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
// The header is one memoized component: its renders and mounts are the page header's.
const header = vi.hoisted(() => ({ renders: 0, mounts: 0 }));
vi.mock("@/components/page-header", async (orig) => {
  const m = await orig<typeof import("@/components/page-header")>();
  const { createElement, useEffect } = await import("react");
  return {
    ...m,
    PageHeader: (p: ComponentProps<typeof m.PageHeader>) => {
      header.renders++;
      // biome-ignore lint/correctness/useExhaustiveDependencies: counts mounts only
      useEffect(() => {
        header.mounts++;
      }, []);
      return createElement(m.PageHeader, p);
    },
  };
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const emptyChat = { entries: [], nextCursor: null, newerCursor: null, working: null };
let chatRequests: string[];
beforeEach(() => {
  chatRequests = [];
  header.renders = 0;
  header.mounts = 0;
  const routes: Record<string, () => Response> = {
    [`/api/agents/${refFor("dev")}`]: () => json(detail()),
    [`/api/agents/${refFor("dev")}/events?`]: () => json(conversation()),
    "/api/agents?": () => json({ agents: [agentSummary()], more: false, running: { count: 0 } }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith(`/api/agents/${refFor("dev")}/chat`)) {
        chatRequests.push(url);
        return json(emptyChat);
      }
      const key = Object.keys(routes)
        .filter((k) => url === k || (k.endsWith("?") && url.startsWith(k)))
        .sort((a, b) => b.length - a.length)[0];
      return key ? (routes[key]?.() ?? json({}, 500)) : json({ error: { code: "not_found" } }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const toSession = (router: ReturnType<typeof renderApp>["router"], search = {}) =>
  act(() =>
    router.navigate({ to: "/agents/$ref/session", params: { ref: refFor("dev") }, search }),
  );
const toChat = (router: ReturnType<typeof renderApp>["router"]) =>
  act(() => router.navigate({ to: "/agents/$ref/chat", params: { ref: refFor("dev") } }));

test("/agents/ada opens as its chat, replacing the history entry", async () => {
  const { router } = renderApp(`/agents/${refFor("dev")}`, alice);
  await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${refFor("dev")}/chat`));
  expect(router.history.canGoBack()).toBe(false);
  expect(await screen.findByRole("heading", { level: 1, name: "Dev agent" })).toBeInTheDocument();
});

test("an agent's chat route is addressed by its ref, and the sidebar links to that ref", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  expect(await screen.findByRole("heading", { level: 1, name: "Dev agent" })).toBeInTheDocument();
  await waitFor(() =>
    expect(document.querySelector(`[data-agent-row="${refFor("dev")}"]`)).toHaveAttribute(
      "href",
      `/agents/${refFor("dev")}/chat`,
    ),
  );
});

test("an unknown ref shows 'No agent at this link.'", async () => {
  const unknown = refFor("nobody");
  const fetchMock = vi.mocked(fetch);
  const answer = fetchMock.getMockImplementation() as (url: string) => Promise<Response>;
  fetchMock.mockImplementation(async (url) =>
    String(url).startsWith(`/api/agents/${unknown}`)
      ? json({ error: { code: "agent_not_found", message: "No agent at this ref" } }, 404)
      : answer(String(url)),
  );
  renderApp(`/agents/${unknown}/chat`, alice);
  expect(await screen.findByText("No agent at this link.")).toBeInTheDocument();
});

test("the tab title names the view: Chat and Session, status prefix kept", async () => {
  const { router } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await waitFor(() => expect(document.title).toBe("Idle · Dev agent · Chat · Open Factory"));
  await toSession(router);
  await waitFor(() => expect(document.title).toBe("Idle · Dev agent · Session · Open Factory"));
});

test("the sidebar row links to the chat and is active on both views", async () => {
  const { router } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const row = () =>
    document.querySelector<HTMLAnchorElement>(`[data-agent-row="${refFor("dev")}"]`);
  await waitFor(() => expect(row()).not.toBeNull());
  expect(row()).toHaveAttribute("href", `/agents/${refFor("dev")}/chat`);
  expect(row()).toHaveAttribute("aria-current", "page");
  await toSession(router);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(`/agents/${refFor("dev")}/session`),
  );
  expect(row()).toHaveAttribute("aria-current", "page");
});

test("the header neither remounts across a switch nor renders for ?event or a chat refetch", async () => {
  const { router, queryClient } = renderApp(`/agents/${refFor("dev")}/session`, alice);
  await screen.findByText("Two entries.");
  expect(header.mounts).toBe(1);
  header.renders = 0;
  await toSession(router, { event: 5 });
  await waitFor(() => expect(router.state.location.search).toEqual({ event: 5 }));
  await screen.findByText("Two entries.");
  // `?event=` renders nothing in the header.
  expect(header.renders).toBe(0);
  await toChat(router);
  await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${refFor("dev")}/chat`));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  // The switch changes the header's title and its switch label once.
  expect(header.renders).toBeLessThanOrEqual(1);
  const afterSwitch = header.renders;
  await act(() => queryClient.invalidateQueries({ queryKey: ["chat", refFor("dev")] }));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  // A chat refetch renders nothing in it.
  expect(header.renders).toBe(afterSwitch);
  expect(header.mounts).toBe(1);
});

test("a chat_changed frame through the socket refreshes the open chat once; a reconnect refreshes it once, not twice", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await waitFor(() => expect(chatRequests).toHaveLength(1));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  act(() => ws.frame({ type: "chat_changed", agent: refFor("dev") }));
  await waitFor(() => expect(chatRequests).toHaveLength(2));
  // The socket reopens: the chat's own refresh runs, and the global invalidation leaves ["chat"] alone.
  act(() => ws.open());
  await waitFor(() => expect(chatRequests).toHaveLength(3));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(chatRequests).toHaveLength(3);
});

test("the chat thread is fetched by the route's loader, once, before the view", async () => {
  const { router } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await waitFor(() => expect(chatRequests).toEqual([`/api/agents/${refFor("dev")}/chat?`]));
  await toSession(router);
  await toChat(router);
  // Cached now: the second visit refreshes behind it.
  await waitFor(() => expect(chatRequests).toHaveLength(2));
});

test("?message= opens the chat around that message", async () => {
  renderApp(`/agents/${refFor("dev")}/chat?message=m1`, alice);
  await waitFor(() =>
    expect(chatRequests).toEqual([`/api/agents/${refFor("dev")}/chat?around=m1`]),
  );
});

/** jsdom has no layout: a scroll position per element, and a 1000px tall content in a 100px box. */
function stubScrolling() {
  const store = new WeakMap<object, number>();
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = ["scrollTop", "scrollHeight", "clientHeight"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  );
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get() {
      return store.get(this) ?? 0;
    },
    set(v: number) {
      store.set(this, v);
    },
  });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 100 });
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d);
      else Reflect.deleteProperty(proto, k);
    }
  };
}

test("a Chat → Session → Chat switch restores the chat's scroll and pin", async () => {
  const restore = stubScrolling();
  try {
    const { router } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
    const view = async () =>
      waitFor(() => {
        const el = document.querySelector<HTMLElement>("[data-chat-view]");
        expect(el).not.toBeNull();
        return el as HTMLElement;
      });
    const first = await view();
    first.scrollTop = 120;
    act(() => {
      first.dispatchEvent(new Event("scroll"));
    });
    expect(readViewPosition(refFor("dev"), "chat")).toEqual({ top: 120, pinned: false });
    await toSession(router);
    await screen.findByText("Two entries.");
    expect(document.querySelector("[data-chat-view]")).toBeNull();
    await toChat(router);
    expect((await view()).scrollTop).toBe(120);
    // Left at the bottom, it comes back pinned: at the bottom (1000), not at the stored top.
    writeViewPosition(refFor("dev"), "chat", { top: 900, pinned: true });
    await toSession(router);
    await screen.findByText("Two entries.");
    await toChat(router);
    expect((await view()).scrollTop).toBe(1000);
  } finally {
    restore();
  }
});

test("the session keeps its place across a switch, and comes back unpinned: a live event raises the pill", async () => {
  const restore = stubScrolling();
  try {
    const { router } = renderApp(`/agents/${refFor("dev")}/session`, alice);
    await screen.findByText("Two entries.");
    const scroller = () =>
      screen.getByRole("log", { name: "Session" }).parentElement as HTMLElement;
    scroller().scrollTop = 300;
    act(() => {
      scroller().dispatchEvent(new Event("scroll"));
    });
    expect(readViewPosition(refFor("dev"), "session")).toEqual({ top: 300, pinned: false });
    await toChat(router);
    await waitFor(() => expect(document.querySelector("[data-chat-view]")).not.toBeNull());
    await toSession(router);
    await screen.findByText("Two entries.");
    await waitFor(() => expect(scroller().scrollTop).toBe(300));
    // Unpinned: a new live row is counted into the pill, not scrolled to.
    act(() =>
      ws.frame({
        type: "session_event",
        agent: refFor("dev"),
        event: { ...se({ type: "assistant_text", text: "later" }), seq: 11 },
      }),
    );
    expect(await screen.findByRole("button", { name: "1 new message" })).toHaveAttribute(
      "data-shown",
    );
    expect(scroller().scrollTop).toBe(300);
  } finally {
    restore();
  }
});
