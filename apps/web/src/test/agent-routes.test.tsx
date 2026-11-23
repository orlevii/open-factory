import { act, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readViewPosition, writeViewPosition } from "@/features/agents/view-memory";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary, conversation, detail } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onStatus?: (s: string) => void; onOpen?: () => void }) => {
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
    "/api/agents/dev": () => json(detail()),
    "/api/agents/dev/events?": () => json(conversation()),
    "/api/agents?": () =>
      json({ agents: [agentSummary()], more: false, running: { count: 0, max: 8 } }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/agents/dev/chat")) {
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
  act(() => router.navigate({ to: "/agents/$slug/session", params: { slug: "dev" }, search }));
const toChat = (router: ReturnType<typeof renderApp>["router"]) =>
  act(() => router.navigate({ to: "/agents/$slug/chat", params: { slug: "dev" } }));

test("/agents/ada opens as its chat, replacing the history entry", async () => {
  const { router } = renderApp("/agents/dev", alice);
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/chat"));
  expect(router.history.canGoBack()).toBe(false);
  expect(await screen.findByRole("heading", { level: 1, name: "Dev agent" })).toBeInTheDocument();
});

test("the tab title names the view: Chat and Session, status prefix kept", async () => {
  const { router } = renderApp("/agents/dev/chat", alice);
  await waitFor(() => expect(document.title).toBe("Idle · Dev agent · Chat · Open Factory"));
  await toSession(router);
  await waitFor(() => expect(document.title).toBe("Idle · Dev agent · Session · Open Factory"));
});

test("the sidebar row links to the chat and is active on both views", async () => {
  const { router } = renderApp("/agents/dev/chat", alice);
  const row = () => document.querySelector<HTMLAnchorElement>('[data-agent-row="dev"]');
  await waitFor(() => expect(row()).not.toBeNull());
  expect(row()).toHaveAttribute("href", "/agents/dev/chat");
  expect(row()).toHaveAttribute("aria-current", "page");
  await toSession(router);
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/session"));
  expect(row()).toHaveAttribute("aria-current", "page");
});

test("the header neither remounts across a switch nor renders for ?event or a chat refetch", async () => {
  const { router, queryClient } = renderApp("/agents/dev/session", alice);
  await screen.findByText("Two entries.");
  expect(header.mounts).toBe(1);
  header.renders = 0;
  await toSession(router, { event: 5 });
  await waitFor(() => expect(router.state.location.search).toEqual({ event: 5 }));
  await screen.findByText("Two entries.");
  await toChat(router);
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/chat"));
  await act(() => queryClient.invalidateQueries({ queryKey: ["chat", "dev"] }));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(header.mounts).toBe(1);
  // The switch changes the header's title and its switch label once; the search and the refetch nothing.
  expect(header.renders).toBeLessThanOrEqual(1);
});

test("the chat thread is fetched by the route's loader, once, before the view", async () => {
  const { router } = renderApp("/agents/dev/chat", alice);
  await waitFor(() => expect(chatRequests).toEqual(["/api/agents/dev/chat?"]));
  await toSession(router);
  await toChat(router);
  // Cached now: the second visit refreshes behind it.
  await waitFor(() => expect(chatRequests).toHaveLength(2));
});

test("?message= opens the chat around that message", async () => {
  renderApp("/agents/dev/chat?message=m1", alice);
  await waitFor(() => expect(chatRequests).toEqual(["/api/agents/dev/chat?around=m1"]));
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
    const { router } = renderApp("/agents/dev/chat", alice);
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
    expect(readViewPosition("dev", "chat")).toEqual({ top: 120, pinned: false });
    await toSession(router);
    await screen.findByText("Two entries.");
    expect(document.querySelector("[data-chat-view]")).toBeNull();
    await toChat(router);
    expect((await view()).scrollTop).toBe(120);
    // Left at the bottom, it comes back pinned: nothing to restore.
    writeViewPosition("dev", "chat", { top: 900, pinned: true });
    await toSession(router);
    await screen.findByText("Two entries.");
    await toChat(router);
    expect((await view()).scrollTop).toBe(0);
  } finally {
    restore();
  }
});

test("the session keeps its place across a switch too, and comes back unpinned", async () => {
  const restore = stubScrolling();
  try {
    renderApp("/agents/dev/session", alice);
    // After the render call (it starts from a clean slate), before the rows load.
    writeViewPosition("dev", "session", { top: 300, pinned: false });
    await screen.findByText("Two entries.");
    const log = screen.getByRole("log", { name: "Session" });
    await waitFor(() => expect((log.parentElement as HTMLElement).scrollTop).toBe(300));
  } finally {
    restore();
  }
});
