import type { ServerMessage } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { inboxQueryKey, unreadQueryKey, useInboxCache } from "./api";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({ push: (_m: ServerMessage) => {} }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void; onOpen?: () => void }) => {
    ws.push = (m) => o.onMessage?.(m);
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 15, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const at = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString();
const item = (n: number, o: Record<string, unknown> = {}) => ({
  id: `i${n}`,
  messageId: `m${n}`,
  kind: "message",
  read: false,
  from: { kind: "agent", name: "dev" },
  to: "@bob",
  preview: `preview ${n}`,
  urgent: false,
  createdAt: at(14, 30 + n),
  link: { kind: "session", agentSlug: "dev", seq: 40 + n },
  ...o,
});
const mention = item(1, {
  kind: "mention",
  to: "@or",
  task: { key: "T-42", title: "Plan the billing migration" },
  link: { kind: "task", key: "T-42", commentId: "c7" },
});
const taskEvent = item(2, {
  kind: "task_event",
  from: { kind: "factory", name: "factory" },
  fact: "done",
  to: "@or",
  task: { key: "T-40", title: "Add usage export" },
  link: { kind: "task", key: "T-40" },
});
const humanMention = item(3, {
  kind: "mention",
  from: { kind: "human", name: "sam" },
  to: "@bob",
  task: { key: "T-1", title: "One" },
  link: { kind: "task", key: "T-1", commentId: "c1" },
});
const world = (
  items: unknown[],
  count = items.filter((i) => !(i as { read: boolean }).read).length,
) => {
  let list = items;
  let unread = count;
  const api = mockApi({
    "GET /api/inbox?": (_b, url) =>
      url.includes("unread=true")
        ? json({
            chats: [],
            items: list.filter((i) => !(i as { read: boolean }).read).slice(0, 5),
            nextCursor: null,
          })
        : json({ chats: [], items: list, nextCursor: null }),
    "GET /api/inbox/unread-count": () => json({ count: unread }),
  });
  // A read the server accepted: the row and the count follow, as a refetch would show.
  for (const i of items as { id: string }[])
    api.on(`POST /api/inbox/${i.id}/read`, () => {
      list = list.map((x) =>
        (x as { id: string }).id === i.id ? { ...(x as object), read: true } : x,
      );
      unread = Math.max(0, unread - 1);
      return json({ ok: true });
    });
  return {
    api,
    set: (l: unknown[], c: number) => {
      list = l;
      unread = c;
    },
  };
};

test("kinds: a mention, a human mention and a task event render their sender lines, badges and targets", async () => {
  world([taskEvent, mention, humanMention]);
  renderApp("/inbox", alice);
  const m = await screen.findByRole("link", {
    name: "Unread, @dev mentioned you on T-42 Plan the billing migration, 14:31",
  });
  expect(m).toHaveAttribute("href", "/tasks/T-42?comment=c7");
  expect(within(m).getByText("T-42")).toHaveClass("font-mono");
  const e = screen.getByRole("link", {
    name: "Unread, Factory, done, T-40 Add usage export, 14:32",
  });
  expect(e).toHaveAttribute("href", "/tasks/T-40");
  expect(within(e).getByText("Done")).toBeInTheDocument();
  const h = screen.getByRole("link", { name: /^Unread, @sam mentioned you on T-1 One/ });
  expect(within(h).getByText("@sam")).toHaveClass("font-mono");
});

test("unread rows have an ink dot (aria-hidden), medium weight and an 'Unread, ' name; read rows don't", async () => {
  world([item(1), item(2, { read: true })]);
  renderApp("/inbox", alice);
  const unread = await screen.findByRole("link", { name: /^Unread, From @dev/ });
  expect(unread.querySelector(".bg-foreground")).not.toBeNull();
  expect(unread.querySelector(".font-medium")).not.toBeNull();
  const read = screen.getByRole("link", { name: /^From @dev/ });
  expect(read.querySelector(".bg-foreground")).toBeNull();
  expect(read.querySelector(".font-medium")).toBeNull();
});

test("opening a row (click) marks it read and drops the sidebar count at once, then fires the request", async () => {
  const { api } = world([item(1), item(2)]);
  renderApp("/inbox", alice);
  expect(await screen.findByRole("link", { name: "Inbox, 2 unread" })).toBeInTheDocument();
  await userEvent.click(await screen.findByRole("link", { name: /^Unread, From @dev.*14:31/ }));
  expect(await screen.findByRole("link", { name: "Inbox, 1 unread" })).toBeInTheDocument();
  await waitFor(() =>
    expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/inbox/i1/read")).toBe(true),
  );
});

test("middle-click and Enter open too; a failing request rolls the row and the count back", async () => {
  const { api } = world([item(1)]);
  api.on("POST /api/inbox/i1/read", () => json({ error: { code: "x", message: "x" } }, 500));
  renderApp("/inbox", alice);
  const row = await screen.findByRole("link", { name: /^Unread, From @dev/ });
  await userEvent.pointer({ keys: "[MouseMiddle]", target: row });
  await waitFor(() =>
    expect(api.calls.filter((c) => c.url === "/api/inbox/i1/read").length).toBeGreaterThan(0),
  );
  // Rolled back after the failure.
  expect(await screen.findByRole("link", { name: /^Unread, From @dev/ })).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "Inbox, 1 unread" })).toBeInTheDocument();
});

test("right-click (auxclick with the right button) leaves the row unread; middle-click opens it", async () => {
  const { api } = world([item(1)]);
  renderApp("/inbox", alice);
  const row = await screen.findByRole("link", { name: /^Unread, From @dev/ });
  const aux = (button: number) =>
    fireEvent(row, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button }));
  aux(2);
  await act(async () => {});
  expect(screen.getByRole("link", { name: /^Unread, From @dev/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Inbox, 1 unread" })).toBeInTheDocument();
  expect(api.calls.some((c) => c.url === "/api/inbox/i1/read")).toBe(false);
  aux(1);
  await waitFor(() => expect(api.calls.some((c) => c.url === "/api/inbox/i1/read")).toBe(true));
});

test("Mark all read: rows turn read at once with upTo = the newest loaded item; the outcome focuses Undo; Undo restores and refocuses the button", async () => {
  const w = world([item(3), item(2), item(1)]);
  w.api.on("POST /api/inbox/read-all", () =>
    json({ readAt: "2026-11-19T15:00:00.123Z", count: 3 }),
  );
  w.api.on("POST /api/inbox/read-all/undo", () => json({ count: 3 }));
  renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
  const post = () => w.api.calls.find((c) => c.url === "/api/inbox/read-all");
  await waitFor(() => expect(post()).toBeDefined());
  expect(post()?.body).toEqual({ upTo: item(3).createdAt });
  expect(await screen.findByText("Marked 3 items as read.")).toBeInTheDocument();
  w.set([item(3, { read: true }), item(2, { read: true }), item(1, { read: true })], 0);
  const undo = await screen.findByRole("button", { name: "Undo" });
  await waitFor(() => expect(undo).toHaveFocus());
  w.set([item(3), item(2), item(1)], 3);
  await userEvent.click(undo);
  await waitFor(() => expect(screen.queryByText("Marked 3 items as read.")).toBeNull());
  expect(w.api.calls.find((c) => c.url === "/api/inbox/read-all/undo")?.body).toEqual({
    readAt: "2026-11-19T15:00:00.123Z",
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Mark all read" })).toHaveFocus());
});

test("Mark all read says '1 item' for one, and a failure reverts with Retry", async () => {
  const w = world([item(1)]);
  let fail = true;
  w.api.on("POST /api/inbox/read-all", () =>
    fail
      ? json({ error: { code: "x", message: "x" } }, 500)
      : json({ readAt: "2026-11-19T15:00:00.123Z", count: 1 }),
  );
  renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
  expect(await screen.findByText(/Couldn't mark the items as read\./)).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: /^Unread, From @dev/ })).toBeInTheDocument();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Marked 1 item as read.")).toBeInTheDocument();
});

test("an undo failure shows its line and Retry", async () => {
  const w = world([item(1)]);
  w.api.on("POST /api/inbox/read-all", () =>
    json({ readAt: "2026-11-19T15:00:00.123Z", count: 1 }),
  );
  w.api.on("POST /api/inbox/read-all/undo", () =>
    json({ error: { code: "x", message: "x" } }, 500),
  );
  renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await screen.findByText(/Couldn't undo\. Try again\./)).toBeInTheDocument();
  w.api.on("POST /api/inbox/read-all/undo", () => json({ count: 1 }));
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByText(/Couldn't undo/)).toBeNull());
});

test("the button hides when nothing is unread", async () => {
  world([item(1, { read: true })]);
  renderApp("/inbox", alice);
  await screen.findByRole("link", { name: /^From @dev/ });
  expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
});

test("the sidebar: count at the right edge, 99+, nothing at 0; the collapsed rail has an ink dot and a tooltip text", async () => {
  const w = world([item(1)], 150);
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", { name: "Inbox, 150 unread" });
  expect(within(link).getByText("99+")).toBeInTheDocument();
  expect(link.querySelector(".group-data-\\[collapsible\\=icon\\]\\:block")).not.toBeNull();
  w.set([item(1)], 3);
  act(() => ws.push({ type: "inbox_changed" }));
  expect(await screen.findByRole("link", { name: "Inbox, 3 unread" })).toBeInTheDocument();
  w.set([item(1, { read: true })], 0);
  act(() => ws.push({ type: "inbox_changed" }));
  await waitFor(() => expect(screen.getByRole("link", { name: "Inbox" })).toBeInTheDocument());
});

describe("per-agent unread in the cache", () => {
  const mk = () => {
    const qc = new QueryClient();
    qc.setQueryData(unreadQueryKey, { count: 3, byAgent: { ada: 2 } });
    qc.setQueryData(inboxQueryKey, {
      pages: [
        {
          items: [
            item(1, { from: { kind: "agent", name: "ada" } }),
            item(2, { from: { kind: "agent", name: "ada" } }),
            item(3, { from: { kind: "agent", name: "bob" } }),
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });
    const { result } = renderHook(() => useInboxCache(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    return { qc, cache: result.current };
  };

  test("opening a row keeps byAgent and decrements its sender", () => {
    const { qc, cache } = mk();
    cache.setRead(new Set(["i1"]), true, -1, [
      item(1, { from: { kind: "agent", name: "ada" } }) as never,
    ]);
    expect(qc.getQueryData(unreadQueryKey)).toEqual({ count: 2, byAgent: { ada: 1 } });
  });

  test("mark all read leaves byAgent for the refetch", () => {
    const { qc, cache } = mk();
    cache.setRead(new Set(["i1", "i2", "i3"]), true, -3);
    expect(qc.getQueryData(unreadQueryKey)).toEqual({ count: 0, byAgent: { ada: 2 } });
  });

  test("readFrom flips that sender's cached rows and zeroes its count", () => {
    const { qc, cache } = mk();
    cache.readFrom("ada");
    expect(qc.getQueryData(unreadQueryKey)).toEqual({ count: 1, byAgent: { ada: 0 } });
    const d = qc.getQueryData<{ pages: { items: { id: string; read: boolean }[] }[] }>(
      inboxQueryKey,
    );
    expect(d?.pages[0]?.items.map((i) => i.read)).toEqual([true, true, false]);
  });

  test("the cache object is stable across renders", () => {
    const qc = new QueryClient();
    const { result, rerender } = renderHook(() => useInboxCache(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
